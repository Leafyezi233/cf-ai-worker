
import { waitUntil, ProxyContext } from "./proxy_context";
import { record } from "./usage_record";
import { upstreamIdentityTerms, joinChunks } from "./stream_relay";
import { cleanResponseHeaders } from "../utils/http";
import { identityRedactionTransform, maskUnparseableModelValues, redactUpstreamIdentity } from "./caller_identity";

const IMAGE_MODEL_PROBE = '"model"';
const IMAGE_HEAD_PROBE_BYTES = 8 * 1024;

export async function relayImageAnswer(ctx: ProxyContext, upstreamRes: Response): Promise<Response> {
  const headers = cleanResponseHeaders(upstreamRes.headers);
  const status = upstreamRes.status;

  if (!upstreamRes.body) {
    ctx.latencyMs = Date.now() - ctx.startedAt;
    waitUntil(ctx.c, record(ctx, null, status));
    return new Response(null, { status, headers });
  }

  const reader = upstreamRes.body.getReader();
  const head: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const probeBudget = IMAGE_HEAD_PROBE_BYTES + IMAGE_MODEL_PROBE.length;
  let probe = "";
  let fedBytes = 0;
  let drained = false;

  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) {
        drained = true;
        break;
      }
      const chunk = read.value as Uint8Array;
      head.push(chunk);
      if (fedBytes < probeBudget) {
        const take = Math.min(chunk.byteLength, probeBudget - fedBytes);
        probe += decoder.decode(chunk.subarray(0, take), { stream: true });
        fedBytes += take;
        if (probe.includes(IMAGE_MODEL_PROBE)) break;
      }
      if (fedBytes >= probeBudget) break;
    }
  } catch {
    ctx.latencyMs = Date.now() - ctx.startedAt;
    waitUntil(ctx.c, record(ctx, null, 502));
    return new Response(
      JSON.stringify({ error: "upstream_read_failed", message: "The upstream answer broke off before it could be relayed" }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }

  ctx.latencyMs = Date.now() - ctx.startedAt;

  if (drained && !probe.includes(IMAGE_MODEL_PROBE)) {
    const bytes = joinChunks(head);
    waitUntil(ctx.c, record(ctx, null, status));
    if (status < 400) return new Response(bytes, { status, headers });
    const failedText = new TextDecoder().decode(bytes);
    return new Response(redactUpstreamIdentity(failedText, upstreamIdentityTerms(ctx)), { status, headers });
  }

  if (probe.includes(IMAGE_MODEL_PROBE)) {
    const rest: Uint8Array[] = [];
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        rest.push(read.value as Uint8Array);
      }
    } catch {
      ctx.latencyMs = Date.now() - ctx.startedAt;
      waitUntil(ctx.c, record(ctx, null, 502));
      return new Response(
        JSON.stringify({ error: "upstream_read_failed", message: "The upstream answer broke off before it could be relayed" }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }
    const bytes = joinChunks([...head, ...rest]);
    let bodyText = "";
    try {
      bodyText = new TextDecoder().decode(bytes);
    } catch {
      bodyText = "";
    }
    let maskedText = maskUnparseableModelValues(bodyText, ctx.visibleModel);
    if (status >= 400) maskedText = redactUpstreamIdentity(maskedText, upstreamIdentityTerms(ctx));
    ctx.latencyMs = Date.now() - ctx.startedAt;
    waitUntil(ctx.c, record(ctx, null, status));
    return new Response(maskedText === bodyText ? bytes : maskedText, { status, headers });
  }

  let resolveDone: () => void = () => {};
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const relayed = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const read = await reader.read();
        if (read.done) {
          controller.close();
          resolveDone();
          return;
        }
        controller.enqueue(read.value as Uint8Array);
      } catch (err) {
        controller.error(err);
        resolveDone();
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
      resolveDone();
    },
  });

  waitUntil(
    ctx.c,
    donePromise.then(async () => {
      ctx.latencyMs = Date.now() - ctx.startedAt;
      await record(ctx, null, status);
    })
  );
  const outBody = status >= 400 ? relayed.pipeThrough(identityRedactionTransform(upstreamIdentityTerms(ctx))) : relayed;
  return new Response(outBody, { status, headers });
}
