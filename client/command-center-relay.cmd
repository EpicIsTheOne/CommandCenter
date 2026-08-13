@echo off
setlocal
set "CLIENT_ROOT=%~dp0.."
node "%CLIENT_ROOT%\client\command-center-relay.mjs" %*
