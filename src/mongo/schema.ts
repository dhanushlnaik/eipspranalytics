import mongoose from "mongoose";

const prSchema = new mongoose.Schema(
  {
    prId: Number,
    number: Number,
    title: String,
    author: String,
    prUrl: String,
    githubLabels: [String],
    state: String,
    mergeable_state: String,
    createdAt: Date,
    updatedAt: Date,
    closedAt: Date,
    mergedAt: Date,
    specType: String,
    draft: Boolean,
    category: String,
    subcategory: String,
    waitingSince: Date, // when current "waiting" state started (for board wait time)
  },
  { strict: false }
);

const chartDataSchema = new mongoose.Schema(
  {
    _id: String,
    category: String,
    monthYear: String,
    type: String,
    count: Number,
  },
  { strict: false }
);

/** Snapshot: open PRs as of a month. Same source for Graph 2/3 counts and details API (metadata). */
const snapshotSchema = new mongoose.Schema(
  {
    month: String, // "YYYY-MM"
    snapshotDate: String, // "YYYY-MM-DD" (e.g. last day of month); "latest per month" = sort by snapshotDate desc
    prs: [mongoose.Schema.Types.Mixed], // full PR docs: number, title, author, prUrl, category, subcategory, etc.
  },
  { strict: false }
);

export const EIP_PR =
  mongoose.models.EIP_PR || mongoose.model("EIP_PR", prSchema, "eipprs");
export const ERC_PR =
  mongoose.models.ERC_PR || mongoose.model("ERC_PR", prSchema, "ercprs");
export const RIP_PR =
  mongoose.models.RIP_PR || mongoose.model("RIP_PR", prSchema, "ripprs");

export const EIPS_PR_CHARTS =
  mongoose.models.EIPS_PR_CHARTS ||
  mongoose.model("EIPS_PR_CHARTS", chartDataSchema, "eipsPRCharts");
export const ERCS_PR_CHARTS =
  mongoose.models.ERCS_PR_CHARTS ||
  mongoose.model("ERCS_PR_CHARTS", chartDataSchema, "ercsPRCharts");
export const RIPS_PR_CHARTS =
  mongoose.models.RIPS_PR_CHARTS ||
  mongoose.model("RIPS_PR_CHARTS", chartDataSchema, "ripsPRCharts");
export const ALL_PR_CHARTS =
  mongoose.models.ALL_PR_CHARTS ||
  mongoose.model("ALL_PR_CHARTS", chartDataSchema, "allPRCharts");

export const EIPS_CATEGORY_CHARTS =
  mongoose.models.EIPS_CATEGORY_CHARTS ||
  mongoose.model("EIPS_CATEGORY_CHARTS", chartDataSchema, "eipsCategoryCharts");
export const ERCS_CATEGORY_CHARTS =
  mongoose.models.ERCS_CATEGORY_CHARTS ||
  mongoose.model("ERCS_CATEGORY_CHARTS", chartDataSchema, "ercsCategoryCharts");
export const RIPS_CATEGORY_CHARTS =
  mongoose.models.RIPS_CATEGORY_CHARTS ||
  mongoose.model("RIPS_CATEGORY_CHARTS", chartDataSchema, "ripsCategoryCharts");
export const ALL_CATEGORY_CHARTS =
  mongoose.models.ALL_CATEGORY_CHARTS ||
  mongoose.model("ALL_CATEGORY_CHARTS", chartDataSchema, "allCategoryCharts");

export const EIPS_SUBCATEGORY_CHARTS =
  mongoose.models.EIPS_SUBCATEGORY_CHARTS ||
  mongoose.model(
    "EIPS_SUBCATEGORY_CHARTS",
    chartDataSchema,
    "eipsSubcategoryCharts"
  );
export const ERCS_SUBCATEGORY_CHARTS =
  mongoose.models.ERCS_SUBCATEGORY_CHARTS ||
  mongoose.model(
    "ERCS_SUBCATEGORY_CHARTS",
    chartDataSchema,
    "ercsSubcategoryCharts"
  );
export const RIPS_SUBCATEGORY_CHARTS =
  mongoose.models.RIPS_SUBCATEGORY_CHARTS ||
  mongoose.model(
    "RIPS_SUBCATEGORY_CHARTS",
    chartDataSchema,
    "ripsSubcategoryCharts"
  );
export const ALL_SUBCATEGORY_CHARTS =
  mongoose.models.ALL_SUBCATEGORY_CHARTS ||
  mongoose.model("ALL_SUBCATEGORY_CHARTS", chartDataSchema, "allSubcategoryCharts");

export const EIPS_CAT_SUB_CHARTS =
  mongoose.models.EIPS_CAT_SUB_CHARTS ||
  mongoose.model(
    "EIPS_CAT_SUB_CHARTS",
    chartDataSchema,
    "eipsCategorySubcategoryCharts"
  );
export const ERCS_CAT_SUB_CHARTS =
  mongoose.models.ERCS_CAT_SUB_CHARTS ||
  mongoose.model(
    "ERCS_CAT_SUB_CHARTS",
    chartDataSchema,
    "ercsCategorySubcategoryCharts"
  );
export const RIPS_CAT_SUB_CHARTS =
  mongoose.models.RIPS_CAT_SUB_CHARTS ||
  mongoose.model(
    "RIPS_CAT_SUB_CHARTS",
    chartDataSchema,
    "ripsCategorySubcategoryCharts"
  );
export const ALL_CAT_SUB_CHARTS =
  mongoose.models.ALL_CAT_SUB_CHARTS ||
  mongoose.model("ALL_CAT_SUB_CHARTS", chartDataSchema, "allCategorySubcategoryCharts");

export const EIP_SNAPSHOTS =
  mongoose.models.EIP_SNAPSHOTS ||
  mongoose.model("EIP_SNAPSHOTS", snapshotSchema, "open_pr_snapshots");
export const ERC_SNAPSHOTS =
  mongoose.models.ERC_SNAPSHOTS ||
  mongoose.model("ERC_SNAPSHOTS", snapshotSchema, "open_erc_pr_snapshots");
export const RIP_SNAPSHOTS =
  mongoose.models.RIP_SNAPSHOTS ||
  mongoose.model("RIP_SNAPSHOTS", snapshotSchema, "open_rip_pr_snapshots");
