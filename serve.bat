@echo off
cd /d %~dp0
echo PlotWrite running at http://localhost:8000  (Ctrl+C to stop)
start http://localhost:8000
python -m http.server 8000 --bind 127.0.0.1
