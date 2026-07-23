import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Personal Touch Car Detailing",
    short_name: "Personal Touch",
    description: "Book vehicle detailing and manage your Personal Touch service visits.",
    start_url: "/",
    display: "standalone",
    background_color: "#F4F6FA",
    theme_color: "#0B2A4A",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
