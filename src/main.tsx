import React from "react";
import ReactDOM from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import App from "./App";
import { recoverSaves } from "./files.ts";

const root = document.getElementById("root");
if (!root) throw new Error("Blueprint's root element is missing.");
const application = ReactDOM.createRoot(root);
async function start() {
  let startupNotice = "";
  try {
    startupNotice = await recoverSaves() || "";
  } catch (error) {
    startupNotice = `Save recovery needs attention: ${error instanceof Error ? error.message : String(error)}`;
  }
  application.render(
    <React.StrictMode>
      <ReactFlowProvider><App startupNotice={startupNotice} /></ReactFlowProvider>
    </React.StrictMode>,
  );
}
void start();
