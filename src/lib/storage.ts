import "server-only";

import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { createHash, createHmac } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, relative, resolve } from "path";

type S3StorageConfig = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

type AzureStorageConfig = {
  accountName: string;
  containerName: string;
  connectionString?: string;
};

function s3StorageConfig(): S3StorageConfig | null {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
  const bucket = process.env.OBJECT_STORAGE_BUCKET;
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    region: process.env.OBJECT_STORAGE_REGION ?? "auto",
    accessKeyId,
    secretAccessKey,
  };
}

function azureStorageConfig(): AzureStorageConfig | null {
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
  if (!accountName || !containerName) return null;
  return {
    accountName,
    containerName,
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
  };
}

let azureContainerPromise: Promise<ContainerClient> | undefined;
function azureContainer(config: AzureStorageConfig): Promise<ContainerClient> {
  if (!azureContainerPromise) {
    azureContainerPromise = Promise.resolve().then(() => {
      const service = config.connectionString
        ? BlobServiceClient.fromConnectionString(config.connectionString)
        : new BlobServiceClient(
            `https://${config.accountName}.blob.core.windows.net`,
            new DefaultAzureCredential(),
          );
      return service.getContainerClient(config.containerName);
    });
  }
  return azureContainerPromise;
}

function safeKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid storage key");
  }
  return normalized;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function objectUrl(config: S3StorageConfig, key: string): URL {
  const url = new URL(config.endpoint);
  const base = url.pathname.replace(/\/$/, "");
  const encodedKey = safeKey(key).split("/").map(encodeURIComponent).join("/");
  url.pathname = `${base}/${encodeURIComponent(config.bucket)}/${encodedKey}`;
  return url;
}

async function signedObjectRequest(
  method: "GET" | "PUT" | "DELETE",
  key: string,
  body?: Buffer,
  contentType?: string,
): Promise<Response> {
  const config = s3StorageConfig();
  if (!config) throw new Error("Object storage is not configured");
  const url = objectUrl(config, key);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? "");
  const canonical: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) canonical["content-type"] = contentType;
  const signedHeaders = Object.keys(canonical).sort();
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${canonical[name].trim()}\n`).join("");
  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const headers = new Headers({
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
  });
  if (contentType) headers.set("content-type", contentType);
  return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
}

function localPath(key: string): string {
  const root = resolve(process.cwd(), "var", "uploads");
  const full = resolve(root, safeKey(key));
  const rel = relative(root, full);
  if (rel.startsWith("..") || rel === "") throw new Error("Invalid storage key");
  return full;
}

export async function putPrivateFile(key: string, data: Buffer, contentType: string): Promise<void> {
  const azureConfig = azureStorageConfig();
  if (azureConfig) {
    const container = await azureContainer(azureConfig);
    await container.getBlockBlobClient(safeKey(key)).uploadData(data, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
    return;
  }
  const s3Config = s3StorageConfig();
  if (s3Config) {
    const response = await signedObjectRequest("PUT", key, data, contentType);
    if (!response.ok) throw new Error(`Object storage upload failed (${response.status})`);
    return;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Private file storage is not configured for production");
  }
  const path = localPath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

export async function getPrivateFile(key: string): Promise<Buffer> {
  const azureConfig = azureStorageConfig();
  if (azureConfig) {
    const container = await azureContainer(azureConfig);
    return container.getBlockBlobClient(safeKey(key)).downloadToBuffer();
  }
  const s3Config = s3StorageConfig();
  if (s3Config) {
    const response = await signedObjectRequest("GET", key);
    if (!response.ok) throw new Error(`Object storage read failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Private file storage is not configured for production");
  }
  return readFile(localPath(key));
}
