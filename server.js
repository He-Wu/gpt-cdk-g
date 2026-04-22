const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;

// 允許跨域並提供靜態文件服務
app.use(cors());
app.use(express.static(__dirname));

/**
 * 動態代理路由
 * 它會讀取請求頭中的 'x-target-url' 並將請求轉發到該地址
 */
app.use('/api-proxy', createProxyMiddleware({
    target: 'http://placeholder.com', // 必須提供但會被 router 覆蓋
    router: (req) => {
        const target = req.headers['x-target-url'];
        if (!target) {
            console.error('Missing x-target-url header');
            return null;
        }
        return target.replace(/\/$/, '');
    },
    changeOrigin: true,
    pathRewrite: {
        '^/api-proxy': '', 
    },
    onProxyReq: (proxyReq, req, res) => {
        // 打印轉發信息方便調試
        console.log(`Proxying: ${req.method} ${req.url} -> ${req.headers['x-target-url']}${req.url}`);
    },
    onError: (err, req, res) => {
        res.status(500).json({ detail: '代理請求失敗: ' + err.message });
    }
}));

app.listen(PORT, () => {
    console.log(`================================================`);
    console.log(`服務已啟動: http://localhost:${PORT}`);
    console.log(`請在瀏覽器中訪問上述地址以避免跨域問題。`);
    console.log(`================================================`);
});
