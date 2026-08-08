@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo 第一次啟動，安裝套件中...
  call npm install
)
echo 正在啟動生產流程管理系統...
echo 本機瀏覽：http://localhost:5050
echo 同一網段的其他電腦/手機，請用下方顯示的區網 IP 網址（不要用 localhost）
node server.js
pause
