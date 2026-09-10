using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;

internal static class CmHook
{
    const string Host = "127.0.0.1";
    const int WaitMs = 4000;

    static int Main(string[] args)
    {
        try
        {
            var hook = args.Length > 0 ? args[0] : "cm-pre-tool";
            var stdin = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8).ReadToEnd();
            var exeDir = AppDomain.CurrentDomain.BaseDirectory;
            var portFile = Path.Combine(Path.GetTempPath(), "contextmind-hookd.port");
            int port;
            string payload;
            if (!TryReadPort(portFile, out port) || !TryCall(port, hook, stdin, out payload))
            {
                SpawnDaemon(exeDir);
                var until = Environment.TickCount + WaitMs;
                var ok = false;
                payload = "{}";
                while (Environment.TickCount < until)
                {
                    Thread.Sleep(25);
                    if (TryReadPort(portFile, out port) && TryCall(port, hook, stdin, out payload))
                    {
                        ok = true;
                        break;
                    }
                }
                if (!ok)
                {
                    return FallbackNode(exeDir, hook, stdin);
                }
            }
            Console.Out.Write(payload);
            if (!payload.EndsWith("\n")) Console.Out.Write("\n");
            return 0;
        }
        catch
        {
            Console.Out.Write("{}\n");
            return 0;
        }
    }

    static bool TryReadPort(string path, out int port)
    {
        port = 0;
        try
        {
            if (!File.Exists(path)) return false;
            var line = File.ReadAllText(path).Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            if (line.Length < 1) return false;
            if (!int.TryParse(line[0].Trim(), out port) || port <= 0) return false;
            if (line.Length >= 2)
            {
                int pid;
                if (int.TryParse(line[1].Trim(), out pid))
                {
                    try { Process.GetProcessById(pid); }
                    catch { return false; }
                }
            }
            return true;
        }
        catch { return false; }
    }

    static bool TryCall(int port, string hook, string stdin, out string payload)
    {
        payload = "{}";
        try
        {
            using (var c = new TcpClient())
            {
                var ar = c.BeginConnect(Host, port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(400)) return false;
                c.EndConnect(ar);
                c.NoDelay = true;
                var req = Encoding.UTF8.GetBytes("{\"hook\":\"" + Escape(hook) + "\",\"input\":" + (string.IsNullOrWhiteSpace(stdin) ? "{}" : stdin) + "}");
                var hdr = new byte[4];
                hdr[0] = (byte)((req.Length >> 24) & 0xff);
                hdr[1] = (byte)((req.Length >> 16) & 0xff);
                hdr[2] = (byte)((req.Length >> 8) & 0xff);
                hdr[3] = (byte)(req.Length & 0xff);
                var s = c.GetStream();
                s.Write(hdr, 0, 4);
                s.Write(req, 0, req.Length);
                s.Flush();
                var rh = ReadExact(s, 4);
                var n = (rh[0] << 24) | (rh[1] << 16) | (rh[2] << 8) | rh[3];
                if (n < 0 || n > 32 * 1024 * 1024) return false;
                var body = Encoding.UTF8.GetString(ReadExact(s, n));
                payload = ExtractPayload(body);
                return true;
            }
        }
        catch { return false; }
    }

    static string ExtractPayload(string body)
    {
        var key = "\"payload\"";
        var i = body.IndexOf(key, StringComparison.Ordinal);
        if (i < 0) return "{}";
        var colon = body.IndexOf(':', i + key.Length);
        if (colon < 0) return "{}";
        var start = colon + 1;
        while (start < body.Length && char.IsWhiteSpace(body[start])) start++;
        if (start >= body.Length) return "{}";
        if (body[start] != '{') return "{}";
        var depth = 0;
        for (var p = start; p < body.Length; p++)
        {
            var ch = body[p];
            if (ch == '{') depth++;
            else if (ch == '}')
            {
                depth--;
                if (depth == 0) return body.Substring(start, p - start + 1);
            }
        }
        return "{}";
    }

    static byte[] ReadExact(Stream s, int n)
    {
        var buf = new byte[n];
        var off = 0;
        while (off < n)
        {
            var r = s.Read(buf, off, n - off);
            if (r <= 0) throw new EndOfStreamException();
            off += r;
        }
        return buf;
    }

    static void SpawnDaemon(string exeDir)
    {
        var script = Path.Combine(exeDir, "cm-hookd.mjs");
        if (!File.Exists(script)) return;
        var psi = new ProcessStartInfo
        {
            FileName = "node",
            Arguments = "\"" + script + "\"",
            WorkingDirectory = exeDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        try { Process.Start(psi); } catch { }
    }

    static int FallbackNode(string exeDir, string hook, string stdin)
    {
        var script = Path.Combine(exeDir, hook + ".mjs");
        if (!File.Exists(script)) script = Path.Combine(exeDir, "cm-pre-tool.mjs");
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "\"" + script + "\"",
                WorkingDirectory = exeDir,
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                CreateNoWindow = true
            };
            using (var p = Process.Start(psi))
            {
                p.StandardInput.Write(stdin);
                p.StandardInput.Close();
                var o = p.StandardOutput.ReadToEnd();
                p.WaitForExit(30000);
                Console.Out.Write(string.IsNullOrEmpty(o) ? "{}\n" : o);
            }
        }
        catch { Console.Out.Write("{}\n"); }
        return 0;
    }

    static string Escape(string s)
    {
        return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}
