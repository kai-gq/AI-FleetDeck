@echo off
rem claude-stub.cmd -- Windows shim for the L2 canary mock LLM.
rem The server spawns this .cmd (runner uses shell:true on Windows, so .cmd
rem executes directly via cmd.exe) which forwards to claude-stub.mjs.
rem NOTE: keep this file ASCII-only -- cmd.exe decodes .cmd in the system
rem codepage (GBK on zh-CN), so UTF-8 Chinese comments corrupt the script.
node "%~dp0claude-stub.mjs" %*
