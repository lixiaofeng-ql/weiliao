/**
 * 微聊 前端运行时配置
 * ---------------------------------------------------------------
 * 部署到 GitHub Pages 等静态托管时，在此处填入后端地址即可。
 * 留空表示与前端同源（后端同时托管前端的情况）。
 *
 * 例：
 *   window.WL_CONFIG = {
 *     apiBase: 'https://your-backend.com',
 *     wsBase: 'wwss://your-backend.com/ws'
 *   };
 */
window.WL_CONFIG = {
  // 后端接口根地址，留空 = 同源
  apiBase: 'https://evident-perfectly-verde-prague.trycloudflare.com',
  // WebSocket 地址，留空 = 根据 apiBase 自动推导，或回退到当前站点
  wsBase: 'wss://evident-perfectly-verde-prague.trycloudflare.com/ws'
};
