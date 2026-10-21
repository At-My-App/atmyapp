import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import atmyapp from "@atmyapp/astro";

export default defineConfig({
  // Your production address, used for canonical links and form redirects.
  site: "https://www.example.com",
  integrations: [atmyapp()],
  vite: {
    plugins: [tailwindcss()],
  },
});
