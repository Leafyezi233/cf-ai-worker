import { Hono } from "hono";
import type { Env } from "../types";
import { addGatewayCorsHeaders } from "../utils/http";
import { handleGatewayProxy } from "./proxy";
import { createVideoHandler, getVideoHandler, listVideoHandler, createStandardVideoHandler, getStandardVideoHandler, listStandardVideoHandler } from "./video";
import { uploadServiceReferenceImage, deleteServiceReferenceImage } from "./video_reference_service";
import { getReferenceVideoLimits, uploadServiceReferenceVideo, deleteServiceReferenceVideo } from "./video_reference_video_service";
import { videoContentHandler, videoContentTicketHandler } from "./video_content";
import { uploadVideoReferenceImage, getVideoReferenceMetadata, getVideoReferenceContent } from "./video_reference_assets";
import { listModelsHandler, getModelHandler, listOllamaTagsHandler } from "./models_endpoints";
import { billingSubscriptionHandler, billingUsageHandler, billingUserBalanceHandler } from "./billing";

export const gatewayApp = new Hono<{ Bindings: Env }>();

gatewayApp.use("*", async (c, next) => {
  const headers = new Headers();
  addGatewayCorsHeaders(headers, c.req.header("origin"), c.env.CORS_ALLOWED_ORIGINS);
  await next();
  c.header("Access-Control-Allow-Origin", headers.get("Access-Control-Allow-Origin") || "*");
  c.header("Access-Control-Allow-Methods", headers.get("Access-Control-Allow-Methods") || "");
  c.header("Access-Control-Allow-Headers", headers.get("Access-Control-Allow-Headers") || "");
  c.header("Access-Control-Expose-Headers", headers.get("Access-Control-Expose-Headers") || "");
  c.header("Access-Control-Max-Age", headers.get("Access-Control-Max-Age") || "86400");
  const vary = headers.get("Vary");
  if (vary) c.header("Vary", vary);
});

gatewayApp.options("*", (c) => c.newResponse(null, 204));

gatewayApp.get("/models", (c) => listModelsHandler(c));
gatewayApp.get("/models/:model", (c) => getModelHandler(c));
gatewayApp.get("/tags", (c) => listOllamaTagsHandler(c));
gatewayApp.get("/model-catalog.json", async (c) => {
  const { listModelProjectionsForDevice } = await import("../db/repo");
  const { buildModelCatalog } = await import("./catalog");
  const { optionalDeviceAuth } = await import("./auth");
  const device = await optionalDeviceAuth(c);
  const items = await listModelProjectionsForDevice(c.env, device);
  const catalog = buildModelCatalog(items);
  return c.json(catalog);
});
gatewayApp.get("/openapi.json", async (c) => {
  const { generateOpenApiSpec } = await import("./openapi");
  const { optionalDeviceAuth } = await import("./auth");
  const reqOrigin = new URL(c.req.url).origin;
  const device = await optionalDeviceAuth(c);
  const spec = await generateOpenApiSpec(c.env, reqOrigin, {
    includePrivateModels: Boolean(device),
    device,
  });
  return c.json(spec);
});

gatewayApp.get("/dashboard/billing/subscription", (c) => billingSubscriptionHandler(c));
gatewayApp.get("/dashboard/billing/usage", (c) => billingUsageHandler(c));
gatewayApp.get("/user/balance", (c) => billingUserBalanceHandler(c));

gatewayApp.post("/messages", (c) => handleGatewayProxy(c, "messages"));
gatewayApp.post("/chat/completions", (c) => handleGatewayProxy(c, "chat/completions"));
gatewayApp.post("/responses", (c) => handleGatewayProxy(c, "responses"));
gatewayApp.post("/embeddings", (c) => handleGatewayProxy(c, "embeddings"));
gatewayApp.get("/videos/reference-videos/limits", getReferenceVideoLimits);
gatewayApp.post("/videos/reference-videos", uploadServiceReferenceVideo);
gatewayApp.delete("/videos/reference-videos/:id", deleteServiceReferenceVideo);
gatewayApp.post("/videos/reference-images", uploadServiceReferenceImage);
gatewayApp.delete("/videos/reference-images/:id", deleteServiceReferenceImage);
gatewayApp.post("/videos/:id/content-ticket", videoContentTicketHandler);
gatewayApp.get("/videos/:id/content", videoContentHandler);
gatewayApp.post("/videos", createStandardVideoHandler);
gatewayApp.get("/videos", listStandardVideoHandler);
gatewayApp.get("/videos/:id", getStandardVideoHandler);
gatewayApp.post("/video/reference-images", uploadVideoReferenceImage);
gatewayApp.get("/video/reference-images/:id/content", getVideoReferenceContent);
gatewayApp.get("/video/reference-images/:id", getVideoReferenceMetadata);
gatewayApp.post("/video/generations/:id/content-ticket", videoContentTicketHandler);
gatewayApp.get("/video/generations/:id/content", videoContentHandler);
gatewayApp.post("/video/generations", createVideoHandler);
gatewayApp.get("/video/generations", listVideoHandler);
gatewayApp.get("/video/generations/:id", getVideoHandler);
gatewayApp.post("/images/generations", (c) => handleGatewayProxy(c, "images/generations"));

gatewayApp.notFound((c) => c.json({ error: "not_found" }, 404));
