import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./app/router";
import "./styles.css";

const neutralRoot = document.getElementById("neutral-root");
if (!neutralRoot) throw new Error("Missing neutral root");
createRoot(neutralRoot).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
// Protected content remains inert and hidden until WEB-08a supplies its exposure gate.
