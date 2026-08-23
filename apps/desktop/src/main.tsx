import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main>
      <p className="eyebrow">AI-NATIVE IDE / FOUNDATION</p>
      <h1>Governed construction begins here.</h1>
      <p>
        The Tauri host is scaffolded. The first governed effect is exercised by the Rust
        foundation slice before this surface gains project controls in T02.
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

