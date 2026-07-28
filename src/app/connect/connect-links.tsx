"use client";

import type { ReactNode } from "react";

export type ConnectAction =
  | "book"
  | "services"
  | "gallery"
  | "reviews"
  | "quote"
  | "call"
  | "directions"
  | "contact"
  | "website";

function trackConnectClick(action: ConnectAction) {
  const endpoint = `/api/connect/click/${action}`;

  if (typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon(endpoint);
    return;
  }

  void fetch(endpoint, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
  });
}

type TrackedLinkProps = {
  action: ConnectAction;
  href: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  external?: boolean;
};

export function TrackedLink({
  action,
  href,
  children,
  className = "",
  ariaLabel,
  external = false,
}: TrackedLinkProps) {
  return (
    <a
      href={href}
      aria-label={ariaLabel}
      className={className}
      onClick={() => trackConnectClick(action)}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {children}
    </a>
  );
}
