// tmux-wrapper: 包装 arndawg tmux-windows(3.6a-win32.7),修复其三个实机验证过的硬伤:
//   1) `new-session -c <绝对路径>` 一律 "create window failed: spawn failed"(只有 /、.、"" 可用)
//      → 改写成 `-c .` + 追加命令 `cmd /k cd /d <目标路径>`,使 pane 的工作目录正确。
//   2) 裸 `sh`/`bash` 在 tmux server 环境里解析不到(spawn failed);`-e` 无法影响程序查找
//      (搜索用的是 server 自身的 PATH)→ 把 `-- sh|bash` 解析为 Git 的 sh.exe 全路径。
//   3) `--` 之后的 argv 被用裸空格拼成一条命令行再解析:含空格的长命令(如 sh -c '<整条命令>')被拆散、
//      pane 秒退 → 多参数先折叠成单个“预引号字符串”,让裸拼接还原正确边界(经 m12/p2 系列实证)。
// 附加:
//   * 给 new-session 注入 `-e PATH=<合并PATH>`(.local\bin / 自身目录 / E:\nodejs / Git / winget 目录…);
//   * 把 `-- claude ...` 的首个 token 解析为绝对路径(优先 %USERPROFILE%\.local\bin\claude.exe),
//     不依赖 tmux server(可能是旧环境)的 PATH —— agent Classic TUI 起不来的根因之一;
//   * 把子进程环境的 SHELL 固定为 cmd.exe:该移植版用 SHELL 决定 default-shell;server 若从 bash 环境
//     启动(bash 导出 SHELL),default-shell 会变成 bash,`-- 命令` 的引号/反斜杠语义整体翻转
//     (实测:折叠参数一律 126/file-not-found 秒退)。固定 SHELL=cmd.exe 后,server 无论从哪个
//     环境启动,行为都与预验证环境一致;
//   * 寻找真 tmux 的顺序:同目录 tmux_real.exe → winget 包目录 → E:\nodejs\tmux_real.exe → PATH 扫描(排除自身)。
// 编译:node build.mjs(系统 .NET Framework csc.exe,C# 5 语法)。
// std 句柄穿透(STARTF_USESTDHANDLES)保证控制台输出/管道/ConPTY 行为正常。
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

class TmuxWrapper
{
    const uint STARTF_USESTDHANDLES = 0x100;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const int STD_INPUT_HANDLE = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE = -12;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles,
        uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int nStdHandle);

    static int Main(string[] args)
    {
        try
        {
            List<string> finalArgs = new List<string>(args);

            if (args.Length > 0 && args[0] == "new-session")
            {
                finalArgs = RewriteNewSession(finalArgs);
            }

            string real = FindRealTmux();
            if (real == null)
            {
                Console.Error.WriteLine("tmux-wrapper: real tmux.exe not found");
                return 127;
            }
            return RunChild(real, finalArgs);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("tmux-wrapper: " + ex.GetType().Name + ": " + ex.Message);
            return 126;
        }
    }

    // ---- new-session 参数改写 ----

    static List<string> RewriteNewSession(List<string> list)
    {
        // 1) -c 改写(注意:`--` 之后是子命令本身,里面的 `sh -c` 等不是 tmux 选项)
        int ci = -1;
        for (int i = 1; i < list.Count - 1; i++)
        {
            if (list[i] == "--") break;
            if (list[i] == "-c") { ci = i; break; }
        }
        if (ci >= 0)
        {
            string val = list[ci + 1];
            // 该移植版对 "/"、"."、"" 处理正常,不动
            if (val != "/" && val != "." && val != "")
            {
                bool commandAlreadyPresent = (ci + 2) < list.Count; // -c 之后还有参数 = 调用方自带命令
                list[ci + 1] = ".";
                if (!commandAlreadyPresent)
                {
                    string norm = val.Replace('/', '\\');
                    string inject;
                    if (norm.IndexOf(' ') >= 0 || norm.IndexOf('\t') >= 0)
                    {
                        string trimmed = norm.TrimEnd(new char[] { '\\' });
                        if (trimmed.Length == 0) trimmed = norm;
                        inject = "cmd /k cd /d \"" + trimmed + "\"";
                    }
                    else
                    {
                        inject = "cmd /k cd /d " + norm;
                    }
                    list.Add(inject);
                }
            }
        }

        // 2) `-- sh|bash` 解析到完整路径(Git 的 MSYS 外壳;修 tmux server 环境里找不到 sh 的问题)
        int dd = list.IndexOf("--");
        if (dd >= 0 && (dd + 1) < list.Count)
        {
            string tok = list[dd + 1];
            if (tok == "sh" || tok == "bash")
            {
                string full = FindUnixShell(tok);
                if (full != null) list[dd + 1] = full;
            }
        }

        // 2.2) `-- claude ...`(交互式 agent 的 Classic TUI):把 claude 解析为绝对路径。
        //      tmux SERVER 用自己的 PATH 做程序查找,server 可能是旧环境 → 交给本进程解析最稳。
        if (dd >= 0 && (dd + 1) < list.Count)
        {
            string cmdTok = list[dd + 1];
            if (cmdTok == "claude" || cmdTok == "claude.exe" || cmdTok == "claude.cmd")
            {
                string claude = FindClaude();
                if (claude != null) list[dd + 1] = claude;
            }
        }

        // 2.5) 该移植版把 `--` 之后的 argv 用裸空格拼成命令行再执行(经 m12/p2 系列实证)。
        //      多参数时必须先折叠为单个“预引号字符串”,否则含空格的参数(如 sh -c 的长命令)会被拆散。
        if (dd >= 0 && (list.Count - (dd + 1)) > 1)
        {
            StringBuilder sb = new StringBuilder();
            for (int i = dd + 1; i < list.Count; i++)
            {
                if (i > dd + 1) sb.Append(' ');
                sb.Append(QuoteArg(list[i]));
            }
            list.RemoveRange(dd + 1, list.Count - (dd + 1));
            list.Add(sb.ToString());
        }

        // 3) 注入扩展 PATH(-e PATH=...):只对已知形态操作,避免破坏位置参数
        if (!HasEnvOverride(list, "PATH"))
        {
            string merged = BuildMergedPath();
            if (merged != null)
            {
                if (dd >= 0)
                {
                    // 插到 `--` 前面
                    list.Insert(dd, "-e");
                    list.Insert(dd + 1, "PATH=" + merged);
                }
                else if (ci >= 0 && list[list.Count - 1].StartsWith("cmd /k ", StringComparison.Ordinal))
                {
                    // 我们刚注入的命令在最后 → -e 插到它前面
                    list.Insert(list.Count - 1, "-e");
                    list.Insert(list.Count - 1, "PATH=" + merged);
                }
                else if (ci >= 0 && (ci + 2) == list.Count)
                {
                    // 形如 [new-session -d -s X -c V](无命令) → 直接追加
                    list.Add("-e");
                    list.Add("PATH=" + merged);
                }
                // 其余未知形态:保守跳过
            }
        }

        return list;
    }

    static bool HasEnvOverride(List<string> list, string key)
    {
        string prefix = key + "=";
        for (int i = 0; i < list.Count - 1; i++)
        {
            if (list[i] == "-e" && list[i + 1].StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    // ---- 环境与路径 ----

    static string BuildMergedPath()
    {
        string current = Environment.GetEnvironmentVariable("PATH") ?? "";
        string sysroot = Environment.GetEnvironmentVariable("SystemRoot") ?? "C:\\Windows";
        string userProfile = Environment.GetEnvironmentVariable("USERPROFILE") ?? "";
        string localApp = Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "";

        List<string> extras = new List<string>();
        if (userProfile.Length > 0) extras.Add(Path.Combine(userProfile, ".local\\bin"));
        string selfDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        if (selfDir != null && selfDir.Length > 0) extras.Add(selfDir);
        extras.Add("E:\\nodejs");
        extras.Add("D:\\Git\\usr\\bin");
        extras.Add("D:\\Git\\bin");
        extras.Add("D:\\Git\\cmd");
        extras.Add(Path.Combine(sysroot, "system32"));
        extras.Add(sysroot);
        extras.Add(Path.Combine(sysroot, "System32\\Wbem"));
        if (localApp.Length > 0)
        {
            string wg = Path.Combine(localApp, "Microsoft\\WinGet\\Packages");
            try
            {
                if (Directory.Exists(wg))
                {
                    string[] dirs = Directory.GetDirectories(wg, "tsl0922.ttyd_*");
                    for (int i = 0; i < dirs.Length; i++) extras.Add(dirs[i]);
                    dirs = Directory.GetDirectories(wg, "arndawg.tmux-windows_*");
                    for (int i = 0; i < dirs.Length; i++) extras.Add(dirs[i]);
                }
            }
            catch { }
        }

        List<string> parts = new List<string>();
        List<string> lowered = new List<string>();
        for (int i = 0; i < extras.Count; i++)
        {
            string e = extras[i].Trim();
            if (e.Length == 0) continue;
            string low = e.ToLowerInvariant();
            if (!lowered.Contains(low)) { parts.Add(e); lowered.Add(low); }
        }
        string[] sep = new string[] { ";" };
        string[] cur = current.Split(sep, StringSplitOptions.RemoveEmptyEntries);
        for (int i = 0; i < cur.Length; i++)
        {
            string e = cur[i].Trim();
            if (e.Length == 0) continue;
            string low = e.ToLowerInvariant();
            if (!lowered.Contains(low)) { parts.Add(e); lowered.Add(low); }
        }
        if (parts.Count == 0) return null;
        return string.Join(";", parts.ToArray());
    }

    static string FindUnixShell(string name)
    {
        string exe = name + ".exe";
        string[] cands = new string[]
        {
            "D:\\Git\\usr\\bin\\" + exe,
            "D:\\Git\\bin\\" + exe,
            "C:\\Program Files\\Git\\usr\\bin\\" + exe,
            "C:\\Program Files\\Git\\bin\\" + exe
        };
        for (int i = 0; i < cands.Length; i++)
        {
            if (File.Exists(cands[i])) return cands[i];
        }
        return null;
    }

    // 解析 claude 可执行文件(原生 .exe;cmd 版 shim 不作为目标,避免多一层 shell)
    static string FindClaude()
    {
        string userProfile = Environment.GetEnvironmentVariable("USERPROFILE") ?? "";
        string localApp = Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "";
        List<string> cands = new List<string>();
        if (userProfile.Length > 0) cands.Add(Path.Combine(userProfile, ".local\\bin\\claude.exe"));
        if (localApp.Length > 0) cands.Add(Path.Combine(localApp, "Programs\\claude\\claude.exe"));
        if (userProfile.Length > 0) cands.Add(Path.Combine(userProfile, ".bun\\bin\\claude.exe"));
        cands.Add("E:\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
        for (int i = 0; i < cands.Count; i++)
        {
            if (File.Exists(cands[i])) return cands[i];
        }
        return null;
    }

    static string FindRealTmux()
    {
        // 0) 同目录的 tmux_real.exe(本工具集 bin/ 部署形态,优先)
        string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
        string selfDir = Path.GetDirectoryName(self);
        if (selfDir != null)
        {
            string sib = Path.Combine(selfDir, "tmux_real.exe");
            if (File.Exists(sib)) return sib;
        }
        // 1) WinGet 包目录(带前缀扫描,防版本目录变化)
        string localApp = Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "";
        if (localApp.Length > 0)
        {
            string wg = Path.Combine(localApp, "Microsoft\\WinGet\\Packages");
            try
            {
                if (Directory.Exists(wg))
                {
                    string[] dirs = Directory.GetDirectories(wg, "arndawg.tmux-windows_*");
                    for (int i = 0; i < dirs.Length; i++)
                    {
                        string f = Path.Combine(dirs[i], "tmux.exe");
                        if (File.Exists(f)) return f;
                    }
                }
            }
            catch { }
        }
        // 2) 固定备用副本
        string alt = "E:\\nodejs\\tmux_real.exe";
        if (File.Exists(alt)) return alt;

        // 3) PATH 扫描,排除自身/同名包装器所在目录
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        string[] dirs2 = path.Split(';');
        string found = null;
        for (int i = 0; i < dirs2.Length; i++)
        {
            string d = dirs2[i].Trim();
            if (d.Length == 0) continue;
            string f;
            try { f = Path.GetFullPath(Path.Combine(d, "tmux.exe")); }
            catch { continue; }
            if (!File.Exists(f)) continue;
            if (string.Equals(f, self, StringComparison.OrdinalIgnoreCase)) continue;
            string low = f.Replace('/', '\\').ToLowerInvariant();
            if (low == "e:\\nodejs\\tmux.exe") continue;
            if (low.EndsWith("\\tide-commander\\tide-commander\\tmux.exe")) continue;
            if (low.IndexOf("winget", StringComparison.OrdinalIgnoreCase) >= 0) return f; // 真身优先
            if (found == null) found = f;
        }
        return found;
    }

    // ---- 子进程执行(句柄穿透) ----

    const string ShellOverride = "C:\\Windows\\System32\\cmd.exe";

    // 该移植版用子进程环境的 SHELL 决定 default-shell:
    //   server 若从 bash 环境启动(bash 导出 SHELL=D:\Git\bin\bash.exe),default-shell 就是 bash,
    //   于是 `-- 命令` 的引号/反斜杠语义整体翻转(实测:折叠参数一律 126/file-not-found 秒退)。
    // 固定 SHELL=cmd.exe,保证 server 无论从哪个环境启动,行为都与预验证环境一致。
    static IntPtr BuildEnvBlock()
    {
        try
        {
            System.Collections.IDictionary vars = Environment.GetEnvironmentVariables();
            List<string> lines = new List<string>();
            foreach (System.Collections.DictionaryEntry de in vars)
            {
                string k = (string)de.Key;
                if (k == null || k.Length == 0) continue;
                if (string.Equals(k, "SHELL", StringComparison.OrdinalIgnoreCase)) continue;
                string v = de.Value == null ? "" : de.Value.ToString();
                lines.Add(k + "=" + v);
            }
            lines.Add("SHELL=" + ShellOverride);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < lines.Count; i++)
            {
                sb.Append(lines[i]);
                sb.Append('\0');
            }
            sb.Append('\0');
            return Marshal.StringToHGlobalUni(sb.ToString());
        }
        catch
        {
            return IntPtr.Zero; // 失败则退回继承环境
        }
    }

    static string QuoteArg(string s)
    {
        if (s.Length > 0 && s.IndexOfAny(new char[] { ' ', '\t', '"' }) == -1) return s;
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        int bs = 0;
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '\\') { bs++; sb.Append(c); }
            else if (c == '"')
            {
                sb.Append(new string('\\', bs * 2 + 1));
                sb.Append('"');
                bs = 0;
            }
            else { bs = 0; sb.Append(c); }
        }
        sb.Append(new string('\\', bs * 2));
        sb.Append('"');
        return sb.ToString();
    }

    static int RunChild(string exe, List<string> args)
    {
        StringBuilder cmd = new StringBuilder();
        cmd.Append(QuoteArg(exe));
        for (int i = 0; i < args.Count; i++)
        {
            cmd.Append(' ');
            cmd.Append(QuoteArg(args[i]));
        }

        STARTUPINFO si = new STARTUPINFO();
        si.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        bool inherit = false;
        IntPtr hin = GetStdHandle(STD_INPUT_HANDLE);
        IntPtr hout = GetStdHandle(STD_OUTPUT_HANDLE);
        IntPtr herr = GetStdHandle(STD_ERROR_HANDLE);
        IntPtr invalid = new IntPtr(-1);
        if (hin != IntPtr.Zero && hin != invalid && hout != IntPtr.Zero && hout != invalid && herr != IntPtr.Zero && herr != invalid)
        {
            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = hin;
            si.hStdOutput = hout;
            si.hStdError = herr;
            inherit = true;
        }

        PROCESS_INFORMATION pi;
        IntPtr envBlk = BuildEnvBlock();
        uint flags = envBlk != IntPtr.Zero ? CREATE_UNICODE_ENVIRONMENT : 0;
        try
        {
            bool ok = CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, inherit, flags, envBlk, null, ref si, out pi);
            if (!ok)
            {
                int err = Marshal.GetLastWin32Error();
                Console.Error.WriteLine("tmux-wrapper: CreateProcess failed, win32 error " + err);
                return 125;
            }
            CloseHandle(pi.hThread);
            WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
            uint code;
            GetExitCodeProcess(pi.hProcess, out code);
            CloseHandle(pi.hProcess);
            return unchecked((int)code);
        }
        finally
        {
            if (envBlk != IntPtr.Zero) Marshal.FreeHGlobal(envBlk);
        }
    }
}
