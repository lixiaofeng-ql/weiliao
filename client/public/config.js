/**
 * 微聊 前端运行时配置
 * ---------------------------------------------------------------
 * 本文件由 scripts/auto-start.ps1 / watchdog.ps1 自动生成，请勿手工修改。
 *
 * apiBases：后端候选地址，按优先级排列。
 *   [0] 正式服务器（固定地址，长期有效）
 *   [1] 本地 Cloudflare 隧道（测试服务，地址会变）
 * 前端会自动探测，主地址不通时无缝切到备用地址。
 */
window.WL_CONFIG = {
  // 后端候选地址（按优先级）
  apiBases: [
    'https://occupied-invision-smart-thesaurus.trycloudflare.com',
    'https://prostores-tracking-roommate-separated.trycloudflare.com'
  ],
  // 主后端接口根地址（兼容旧版读取方式）
  apiBase: 'https://occupied-invision-smart-thesaurus.trycloudflare.com',
  // WebSocket 地址
  wsBase: 'wss://prostores-tracking-roommate-separated.trycloudflare.com/ws'
};