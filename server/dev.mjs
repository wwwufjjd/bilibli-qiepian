import express from "express";
import { createServer as createViteServer } from "vite";
import { createApiRouter, startRecordingAutoMonitor } from "./routes.mjs";

const app = express();
const port = Number(process.env.PORT || 5173);

app.use(express.json({ limit: "20mb" }));
app.get("/favicon.ico", (_req, res) => res.status(204).end());
app.use("/api", createApiRouter());
startRecordingAutoMonitor();

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "spa"
});

app.use(vite.middlewares);

app.listen(port, "127.0.0.1", () => {
  console.log(`Bilive workbench running at http://127.0.0.1:${port}`);
});
