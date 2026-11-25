import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Toolchain placeholder: replace with the game client.
const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <h1>Caxio</h1>
  </StrictMode>,
);
