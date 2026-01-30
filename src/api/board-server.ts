/**
 * Minimal Express server for EIP/ERC/RIP board API.
 * GET /api/boards/:spec — open PRs with optional filters (subcategory, category, sort).
 * Run: npm run build && node dist/api/board-server.js
 */
import dotenv from "dotenv";
dotenv.config();

import express, { type Request, type Response, type NextFunction } from "express";
import mongoose from "mongoose";
import { MONGODB_URI, MONGODB_DATABASE } from "../config";
import { EIP_PR, ERC_PR, RIP_PR } from "../mongo/schema";
import { getBoardRows, getBoardAggregation, type BoardFilters } from "./board-service";

if (!MONGODB_URI || !MONGODB_DATABASE) {
  throw new Error("OPENPRS_MONGODB_URI and OPENPRS_DATABASE must be set in .env");
}

const SPEC_TO_MODEL: Record<string, typeof EIP_PR> = {
  eips: EIP_PR,
  ercs: ERC_PR,
  rips: RIP_PR,
};

const app = express();
app.use(express.json());

// CORS for frontend (allow all origins in dev; tighten in production)
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.get("/api/boards/:spec", async (req: Request, res: Response) => {
  const spec = (req.params.spec ?? "").toLowerCase();
  const model = SPEC_TO_MODEL[spec];
  if (!model) {
    res.status(400).json({
      error: "Invalid spec",
      allowed: ["eips", "ercs", "rips"],
    });
    return;
  }

  const filters: BoardFilters = {};
  if (req.query.subcategory != null && req.query.subcategory !== "")
    filters.subcategory = String(req.query.subcategory);
  if (req.query.category != null && req.query.category !== "")
    filters.category = String(req.query.category);
  if (req.query.sort === "created") filters.sort = "created";
  else filters.sort = "waitTime";

  try {
    const rows = await getBoardRows(model, filters);
    res.json(rows);
  } catch (e) {
    console.error("[board-api]", e);
    res.status(500).json({ error: "Failed to fetch board" });
  }
});

app.get("/api/boards", (_req: Request, res: Response) => {
  res.json({
    message: "Use GET /api/boards/:spec with spec = eips | ercs | rips",
    queryParams: {
      subcategory: "Optional. e.g. 'Waiting on Editor', 'Waiting on Author'",
      category: "Optional. e.g. 'Typo', 'PR DRAFT', 'New EIP'",
      sort: "Optional. 'waitTime' (default) | 'created'",
    },
  });
});

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  await mongoose.connect(MONGODB_URI!, { dbName: MONGODB_DATABASE });
  app.listen(PORT, () => {
    console.log(`Board API: http://localhost:${PORT}/api/boards`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
