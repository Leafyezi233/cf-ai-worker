/**
 * Plain-language explanations for the error codes the gateway returns as `{ "error": "<code>" }`.
 * The API bodies stay unchanged for clients; the console uses this table to tell people what
 * happened and what to do next.
 */
export interface GatewayErrorHelp {
  code: string;
  what: string;
  fix: string;
}

export const GATEWAY_ERROR_HELP: readonly GatewayErrorHelp[] = [
  { code: "unauthorized", what: "Token 无效或没有带上", fix: "检查请求头 Authorization: Bearer 后面的 Token 是否完整。" },
  { code: "token_revoked", what: "这个 API 密钥已被撤销", fix: "在「API 密钥」里换一个有效的密钥。" },
  { code: "calls_disabled", what: "主 Token 已被禁止直接调用", fix: "改用「API 密钥」里的子 Token，或在「账户与安全」里恢复主 Token 调用。" },
  { code: "insufficient_balance", what: "可用余额不足", fix: "联系管理员充值后再试。" },
  { code: "monthly_budget_exceeded", what: "本月花费已到上限", fix: "等下个月自动恢复，或联系管理员调整上限。" },
  { code: "rate_limit_exceeded", what: "请求太频繁", fix: "稍等几秒再试，或降低并发。" },
  { code: "model_not_found", what: "没有这个模型", fix: "到「模型广场」复制准确的模型名。" },
  { code: "model_not_in_scope", what: "你的账户不能使用这个模型", fix: "换一个「模型广场」里列出的模型，或联系管理员开通。" },
  { code: "service_group_not_allowed", what: "你的账户不能使用这个服务分组", fix: "换一个可用的分组，或联系管理员开通。" },
  { code: "model_pricing_missing", what: "这个模型还没有设置价格，暂时不能调用", fix: "换一个模型，或联系管理员设置价格。" },
  { code: "per_call_text_only", what: "这个按次计费的模型需要带图片输入", fix: "带上图片，或改用支持纯文本的模型。" },
  { code: "request_too_large", what: "请求内容太大", fix: "缩短输入，或减少图片和附件。" },
  { code: "invalid_body", what: "请求格式不对", fix: "检查请求体是不是合法的 JSON，字段名是否正确。" },
  { code: "upstream_service_unavailable", what: "上游模型服务暂时不可用", fix: "稍后再试；一直失败请联系管理员。" },
];

const BY_CODE = new Map(GATEWAY_ERROR_HELP.map(item => [item.code, item]));

export function gatewayErrorHelp(code: string | undefined | null): GatewayErrorHelp | undefined {
  return code ? BY_CODE.get(code) : undefined;
}

/**
 * One line for an error shown in the console: the plain explanation when the code is known,
 * otherwise the server's own message. The code stays visible so it can be reported as-is.
 */
export function explainGatewayError(code: string | undefined | null, message: string): string {
  const help = gatewayErrorHelp(code);
  if (!help) return message;
  return `${help.what}。${help.fix}（错误码 ${help.code}）`;
}
