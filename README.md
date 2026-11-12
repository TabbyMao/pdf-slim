# PDF Slim

**🌐 在线使用 / Live site: [https://pdf-slim.pages.dev](https://pdf-slim.pages.dev)**

[中文](#中文) · [English](#english)

---

## 中文

PDF Slim 是一个在浏览器里运行的 PDF 压缩工具，适合 GoodNotes 等手写笔记和电子教材。

### 特点

- **本地处理，不上传**：所有压缩都在你的浏览器里完成，文件不会离开你的电脑。
- **保持可编辑**：页面不会被转成图片。文字依然可以选中、搜索、复制；已有的高亮、下划线、批注、超链接、目录书签都会保留，压缩后也能继续添加。
- **两项可调设置**
  - **笔迹 / 矢量图形**：保持原样 / 标准 / 强力。GoodNotes 导出的笔迹坐标带有大量多余的小数位，降低精度后肉眼看不出区别，文件却能小一半以上。
  - **图片**：保持原样 / 高清（200 dpi）/ 均衡（150 dpi）/ 小体积（100 dpi）。只缩小分辨率超过页面需要的图片。
- **无损整理**：合并重复资源，删除缩略图等冗余数据，用最高压缩级别重新打包。
- 支持一次处理多个文件。

### 效果示例

| 文件 | 原大小 | 压缩后 |
|---|---|---|
| GoodNotes 笔记，42 页（标准） | 3.7 MB | 1.8 MB |
| GoodNotes 笔记，42 页（强力） | 3.7 MB | 1.2 MB |

### 暂不支持

- 带密码或权限限制的加密 PDF
- 已经很精简的文件（例如黑白扫描版教材）可能只能缩小一点点

### 本地运行

这是一个纯静态网页，不需要安装或构建。克隆仓库后，用任意静态服务器打开即可，例如：

```bash
python -m http.server 8000
```

然后在浏览器里访问 `http://localhost:8000`。

### 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | 页面和交互 |
| `core.js` | 压缩核心逻辑 |
| `pdf-lib.min.js`, `pako.min.js` | 第三方库（MIT 许可，见 `THIRD_PARTY_NOTICES.txt`） |

---

## English

PDF Slim is a browser-based PDF compressor built for handwritten notes (GoodNotes and similar) and e-textbooks.

### Features

- **Private by design**: compression runs entirely in your browser. Your files never leave your device.
- **Stays editable**: pages are never flattened into images. Text remains selectable, searchable and copyable. Existing highlights, underlines, annotations, links and bookmarks are preserved, and you can keep annotating the compressed file.
- **Two adjustable settings**
  - **Strokes & vector graphics**: Original / Balanced / Maximum. GoodNotes exports store pen-stroke coordinates with far more decimal places than the eye can see. Trimming that precision often halves the file with no visible change.
  - **Images**: Original / High (200 dpi) / Balanced (150 dpi) / Small (100 dpi). Only images with more resolution than the page needs get resized.
- **Lossless cleanup**: merges duplicate resources, removes thumbnails and other junk data, and repacks the file at maximum compression.
- Handles multiple files at once.

### Example results

| File | Original | Compressed |
|---|---|---|
| GoodNotes notes, 42 pages (Balanced) | 3.7 MB | 1.8 MB |
| GoodNotes notes, 42 pages (Maximum) | 3.7 MB | 1.2 MB |

### Not supported yet

- Encrypted PDFs (password or permission restrictions)
- Files that are already lean (e.g. black-and-white scanned books) may only shrink slightly

### Run locally

It's a plain static site, so there is nothing to install or build. Clone the repo and serve the folder with any static server, for example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

### Files

| File | Purpose |
|---|---|
| `index.html` | Page and UI |
| `core.js` | Compression engine |
| `pdf-lib.min.js`, `pako.min.js` | Third-party libraries (MIT licensed, see `THIRD_PARTY_NOTICES.txt`) |
