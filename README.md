# The Box of Fragments

一个可以拖拽“记忆盒子”、打开羊皮纸卷轴并与 Agent 对话的网页小玩具。

## 运行（前端）

这是纯静态前端（可直接双击 `index.html` 打开）。但要真正对话，需要一个 **Agent 代理服务**（见下文）。

目录：
- `index.html`：页面
- `styles.css`：样式
- `app.js`：逻辑（盒子/对话/本地存储/Agent 调用/设置面板）

## 本地存储（刷新不丢）

盒子位置、标题、对话历史会保存到浏览器 `localStorage`（本机本浏览器）。

## Agent 调用：为什么需要“代理”

为了把项目放到 GitHub（任何人都能玩），前端 **不能** 内置你的 API Key。
因此我们使用一个你自己部署/运行的代理服务（把 Key 放在服务器/Worker 环境变量里），前端只请求代理地址。

前端里可以在「设置」中填写代理地址并测试连接。

---

## 方案 A：本地 Node 代理（开发最简单）

Node 18+：

```bash
cd "/Users/xuranlee/Desktop/未命名文件夹/box of fragments idea/box-of-fragments-web"
export PROVIDER="anthropic"              # 或 openai
export MODEL="claude-3-5-sonnet-20241022"
export ANTHROPIC_API_KEY="你的key"
node agent-proxy.mjs
```

然后在网页「设置」里填：
- `http://127.0.0.1:8787/api/chat`

### 使用智谱（BigModel）Key（OpenAI 兼容）

智谱提供 OpenAI 兼容接口，可以直接复用 `PROVIDER="openai"`，并指定 `OPENAI_BASE_URL`：

```bash
cd "/Users/xuranlee/Desktop/未命名文件夹/box of fragments idea/box-of-fragments-web"
export PROVIDER="openai"
export OPENAI_API_KEY="你的智谱 Key"
export OPENAI_BASE_URL="https://open.bigmodel.cn/api/paas/v4/"
export MODEL="glm-4.7"
node agent-proxy.mjs
```

---

## 方案 B：Cloudflare Worker 代理（适合公开部署）

安装 `wrangler` 后：

```bash
cd worker
wrangler login
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
```

部署完成会得到一个 Worker URL，把它的 `/api/chat` 填到网页「设置」里即可。

`/health` 可用于测试连通性。

---

## GitHub Pages

这是纯静态网页，最适合用 **GitHub Pages** 发布（免费、无需服务器）。

### 发布步骤（推荐：仓库根目录就是本项目）

1. 在 GitHub 新建一个仓库（例如 `box-of-fragments`）
2. 把本目录下的文件放到仓库根目录并推送（不要提交任何 API Key）
   - 需要包含：`index.html` / `styles.css` / `app.js` / `ocean-bg.js`
3. 打开仓库的 `Settings → Pages`
4. `Build and deployment` 里选择：
   - **Source**: `Deploy from a branch`
   - **Branch**: `main`（或 `master`） / `/ (root)`
5. 保存后等待 1-3 分钟，会生成一个 Pages 地址（形如 `https://<你的用户名>.github.io/<仓库名>/`）

### 重要：别人打开网页后怎么“能对话”

GitHub Pages 只托管前端静态文件；**对话需要一个 Agent 代理服务**：
- 你可以让用户在网页「设置」里填他们自己的代理地址（本地 Node 或自己部署的 Worker）
- 或者你自己部署一个公开代理（不推荐：会暴露你的付费消耗与风控压力）

