import { createRoot } from "react-dom/client"
import SidePanelApp from "./App"
import "./index.css"

const container = document.getElementById("root")
if (!container) throw new Error("Orbit Side Panel root is unavailable")

createRoot(container).render(<SidePanelApp />)
