import { Hono } from "hono";
import { handleHttpError } from "../utils/http-errors";
import type { Env } from "../types";
import { adminAuth } from "../middleware/adminAuth";
import { authApp } from "./auth";
import { providersApp } from "./providers";
import { modelsApp } from "./models";
import { modelGroupsApp } from "./model-groups";
import { modelGroupMergeApp } from "./model-group-merge";
import { modelCategoriesApp } from "./model-categories";
import { serviceGroupsApp } from "./service-groups";
import { devicesApp } from "./devices";
import { usageApp } from "./usage";
import { settingsApp } from "./settings";
import { cacheAdminApp } from "./cache";
import { auditApp } from "./audit";
import { playgroundApp } from "./playground";
import { deviceTemplatesApp } from "./device-templates";
import { videoTasksApp } from "./video-tasks";
import { monthlyPassesApp } from "./monthly-passes";
import { usageRetentionApp } from "./usage-retention";
import { attentionApp } from "./attention";

export const adminApp = new Hono<{ Bindings: Env }>();
adminApp.onError(handleHttpError);

adminApp.get("/health", (c) => c.json({ ok: true, service: "personal-ai-gateway" }));

adminApp.route("/auth", authApp);

adminApp.use("*", adminAuth);

adminApp.route("/attention", attentionApp);
adminApp.route("/monthly-passes", monthlyPassesApp);
adminApp.route("/usage-retention", usageRetentionApp);
adminApp.route("/video-tasks", videoTasksApp);
adminApp.route("/providers", providersApp);
adminApp.route("/models", modelsApp);
adminApp.route("/model-groups", modelGroupsApp);
adminApp.route("/model-group-merge", modelGroupMergeApp);
adminApp.route("/model-categories", modelCategoriesApp);
adminApp.route("/service-groups", serviceGroupsApp);
adminApp.route("/devices", devicesApp);
adminApp.route("/usage", usageApp);
adminApp.route("/settings", settingsApp);
adminApp.route("/cache", cacheAdminApp);
adminApp.route("/audit-logs", auditApp);
adminApp.route("/playground", playgroundApp);
adminApp.route("/device-templates", deviceTemplatesApp);

