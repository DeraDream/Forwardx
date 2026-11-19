# 网络拓扑「链路视图」UI 改版交接文档

> 范围：仅调整网络拓扑页面的**链路视图列表 UI 实现**。不得改变探测、轮询、数据匹配、权限、路由跳转或后端接口行为。

## 1. 文件与改动范围

### 允许修改

- `client/src/pages/NetworkTopology.tsx`
- 可在 `client/src/pages/` 下新建仅供该页面使用的 UI 子组件。
- 如有必要，可为 UI 展示补充对应的前端测试。

主要入口组件为 `TopologyLane`。

### 不要修改

- tRPC 查询及 mutation：`rules.startSelfTest`、`rules.latestTests`。
- 10 秒轮询、页面卸载停止轮询、上一次成功延迟缓存。
- `buildPhysicalPaths`、`relationshipOverviewPaths`、`buildGraph` 等拓扑建模与路径计算。
- `edgeMeasurementLabel` 的延迟匹配规则。
- 「关系总览」视图。
- Agent、服务端路由、数据库、版本号、发布工作流及全局 CSS。

## 2. 技术约束

| 项目 | 约束 |
|---|---|
| 前端 | React + TypeScript |
| 样式 | Tailwind CSS；优先复用现有 shadcn/ui 组件 |
| 图标 | `lucide-react` |
| 数据 | tRPC，已有请求和数据流不可替换 |
| 文案 | 保持中文 |
| 主题 | 必须兼容现有亮色/暗色主题 |
| 依赖 | 不新增 UI 框架、图表库或状态库；不改全局 CSS |

## 3. 必须保持的组件接口

```ts
function TopologyLane({
  path,
  metrics,
  edgeLatency,
  selected,
  onSelectPath,
  onSelectNode,
}: {
  path: PhysicalPath;
  metrics?: TopologyPathMetrics;
  edgeLatency?: (from: PhysicalNode, to: PhysicalNode) => string;
  selected: boolean;
  onSelectPath: () => void;
  onSelectNode: (node: PhysicalNode) => void;
})
```

允许拆分成 UI 子组件，例如 `TopologyLaneHeader`、`TopologyNode`、`TopologyEdge`，但上述 props、调用方和行为必须保持兼容。

## 4. 数据合同

```ts
type PhysicalNode = {
  id: string;                 // 例：host:2、landing:17、target:IP:PORT
  kind: "entry" | "relay" | "landing";
  label: string;              // VPS 名称、外部 SS 名称或目标 IP/域名
  subtitle?: string;          // IP、域名或端口
  detail?: string;            // 例：落地 SS · 443、最终目标
  online?: boolean | null;
};

type PhysicalPath = {
  id: string;
  name: string;
  category: "local" | "tunnel" | "chain" | "group" | "fullchain";
  entry: PhysicalNode;
  relays: PhysicalNode[];
  landing: PhysicalNode;
};

type TopologyPathMetrics = {
  bytesIn: number;
  bytesOut: number;
  bytesInPerSecond: number;
  bytesOutPerSecond: number;
  latestLatencyMs?: number | null;
  latestLatencyIsTimeout?: boolean;
};
```

`edgeLatency(from, to)` 的返回值只能直接展示，不得重新计算：

```text
"31 ms" | "超时" | "探测中" | "待探测"
```

禁止添加 `TCP` / `Ping` 前缀；禁止把多个结果拼接到同一条边。

## 5. 必须保留的交互与行为

- item 标题区域点击必须调用 `onSelectPath()`。
- 节点点击必须调用 `onSelectNode(node)`，并阻止错误触发父级选择。
- `selected` 状态必须有可见样式反馈。
- 节点应继续使用可访问的 `button type="button"`，保留 hover/focus 状态。
- 外层筛选、搜索、刷新、视图切换均不得删除、移动或改变行为。
- 路径节点顺序固定为：`entry → ...relays → landing`。
- 允许横向滚动处理长路径；不得截断数据、合并节点或改变路径顺序。

## 6. 验收与自测

人工检查：

- [ ] 入口 → 中转 → 托管落地。
- [ ] 入口 → 外部 IP 落地。
- [ ] 入口 → 中转 → 外部域名 SS。
- [ ] 4 跳及以上路径不重叠，节点顺序正确。
- [ ] `31 ms`、`待探测`、`探测中`、`超时`均可正常显示。
- [ ] 有/无流量、有/无总延迟、外部 SS 的数据不会导致运行时异常。
- [ ] 亮色与暗色主题均可用。
- [ ] item 选中、节点点击、筛选及搜索行为正常。

必须执行：

```bash
pnpm exec tsc --noEmit
node --import tsx --test client/src/pages/networkTopologyModel.test.ts
./node_modules/.bin/esbuild client/src/pages/NetworkTopology.tsx \
  --bundle --platform=browser --format=esm --outfile=/tmp/network-topology.js --external:@/*
```

## 7. 禁止事项

- 不要 mock、硬编码路径、延迟、流量或节点数据。
- 不要增加第二套“拓扑探测”；拓扑必须复用规则页链路测试。
- 不要修改 tRPC API、Agent 任务、数据库表或服务端路由。
- 不要删除“待探测”状态。
- 不要提交、推送、升级版本或发布；由项目维护者统一处理。
