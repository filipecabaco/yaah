#!/usr/bin/env elixir
# Serve a built frontend (app/dist) with the Content-Security-Policy a release
# build of yaah sends, so the main flows can be checked for CSP violations in a
# browser before a `pnpm tauri build` (dev builds apply no CSP: `devCsp` is null).
#
#   elixir app/scripts/csp-serve.exs [--port 4173] [--dist app/dist] [--conf app/src-tauri/tauri.conf.json]
#   elixir app/scripts/csp-serve.exs --print          # the policy for index.html, then exit
#   elixir app/scripts/csp-serve.exs --style-nonce    # as Tauri does when style-src may be modified
#
# The policy is built the way Tauri 2 (tauri-codegen 2.7, tauri 2.12) builds it
# for an HTML asset:
#   - `app.security.csp` from tauri.conf.json, directive by directive;
#   - unless `dangerousDisableAssetCspModification` covers `script-src`: the
#     SHA-256 of every .js/.mjs file in dist and of every inline <script> in the
#     page are added to script-src (with 'self');
#   - unless it covers `style-src`: every <style> element gets a fresh nonce,
#     added to style-src. A nonce makes browsers ignore 'unsafe-inline', so
#     inline style attributes and injected <style> elements would be blocked.
#
# The exact policy goes in `Content-Security-Policy`. A copy with a report-uri
# goes in `Content-Security-Policy-Report-Only`, so every violation (the same
# ones, the policies being equal) is also POSTed here: printed, and listed as
# JSON at GET /__csp-reports (DELETE clears it). The page itself is unchanged.
#
# A production bundle needs Tauri to run; to drive it in a plain browser, build
# it with the browser mock (as docs/experiments/2026-11-03-performance/frontend/harness
# does) and pass that folder with --dist.
#
# Bare Plug + Bandit rather than Francis: one catch-all handler and no routes.

Mix.install([
  {:bandit, "~> 1.12"},
  {:plug, "~> 1.20"}
])

defmodule CspServe.Policy do
  @moduledoc "The release CSP for an HTML page, as Tauri builds it."

  def load_conf(path) do
    conf = path |> File.read!() |> JSON.decode!()
    security = get_in(conf, ["app", "security"]) || %{}
    csp = security["csp"] || raise "no app.security.csp in #{path}"

    directives =
      case csp do
        m when is_map(m) -> Enum.map(m, fn {k, v} -> {k, sources(v)} end)
        s when is_binary(s) -> s |> String.split(";", trim: true) |> Enum.map(&parse_directive/1)
      end

    disabled =
      case security["dangerousDisableAssetCspModification"] do
        true -> :all
        list when is_list(list) -> list
        _ -> []
      end

    %{directives: directives, disabled: disabled}
  end

  defp sources(v) when is_list(v), do: v
  defp sources(v) when is_binary(v), do: String.split(v, " ", trim: true)

  defp parse_directive(d) do
    [name | srcs] = d |> String.trim() |> String.split(" ", trim: true)
    {name, srcs}
  end

  def can_modify?(%{disabled: :all}, _), do: false
  def can_modify?(%{disabled: list}, directive), do: directive not in list

  @doc "SHA-256 of every script file in dist, as Tauri hashes them (CRLF → LF)."
  def script_file_hashes(dist) do
    Path.wildcard(Path.join(dist, "**/*.{js,mjs}"))
    |> Enum.map(&(&1 |> File.read!() |> hash()))
    |> Enum.sort()
  end

  def hash(bytes) do
    normalized = bytes |> String.replace("\r\n", "\n") |> String.replace("\r", "\n")
    "'sha256-" <> Base.encode64(:crypto.hash(:sha256, normalized)) <> "'"
  end

  @doc "The page as served and its policy: nonces on <style>, hashes of inline scripts."
  def for_page(policy, html, file_hashes, opts) do
    style_nonce? = Keyword.get(opts, :style_nonce, false) or can_modify?(policy, "style-src")
    script? = can_modify?(policy, "script-src")

    {html, style_nonces} =
      if style_nonce? do
        nonce_tags(html)
      else
        {html, []}
      end

    inline =
      Regex.scan(~r/<script\b[^>]*>(.*?)<\/script>/s, html, capture: :all_but_first)
      |> Enum.map(fn [body] -> body end)
      |> Enum.reject(&(&1 == ""))
      |> Enum.map(&hash/1)

    directives =
      policy.directives
      |> add("script-src", if(script?, do: inline ++ file_hashes, else: []))
      |> add("style-src", Enum.map(style_nonces, &"'nonce-#{&1}'"))

    {html, render(directives)}
  end

  defp nonce_tags(html) do
    {parts, nonces} =
      Regex.split(~r/<style(?=[\s>])/, html, include_captures: true)
      |> Enum.map_reduce([], fn
        "<style", acc ->
          n = :crypto.strong_rand_bytes(8) |> :binary.decode_unsigned()
          {~s(<style nonce="#{n}"), [n | acc]}

        part, acc ->
          {part, acc}
      end)

    {Enum.join(parts), Enum.reverse(nonces)}
  end

  # Tauri adds 'self' and the sources only when there is something to add.
  defp add(directives, _name, []), do: directives

  defp add(directives, name, extra) do
    if List.keymember?(directives, name, 0) do
      List.keyreplace(directives, name, 0, {name, with_self(elem(List.keyfind(directives, name, 0), 1)) ++ extra})
    else
      directives ++ [{name, ["'self'" | extra]}]
    end
  end

  defp with_self(srcs), do: if("'self'" in srcs, do: srcs, else: srcs ++ ["'self'"])

  def render(directives), do: Enum.map_join(directives, "; ", fn {k, v} -> Enum.join([k | v], " ") end)
end

defmodule CspServe.Reports do
  use Agent
  def start_link(_), do: Agent.start_link(fn -> [] end, name: __MODULE__)
  def add(r), do: Agent.update(__MODULE__, &[r | &1])
  def all, do: Agent.get(__MODULE__, &Enum.reverse/1)
  def clear, do: Agent.update(__MODULE__, fn _ -> [] end)
end

defmodule CspServe.Plug do
  @behaviour Plug
  import Plug.Conn

  def init(opts), do: opts

  def call(%{method: "POST", request_path: "/__csp-report"} = conn, _opts) do
    {:ok, body, conn} = read_body(conn, length: 1_000_000)
    report = case JSON.decode(body) do
      {:ok, v} -> v
      _ -> %{"raw" => body}
    end
    r = report["csp-report"] || report
    IO.puts(:stderr, "CSP violation: #{r["violated-directive"] || r["effectiveDirective"]} blocked #{r["blocked-uri"] || r["blockedURL"]} on #{r["document-uri"] || r["documentURL"]}")
    CspServe.Reports.add(report)
    send_resp(conn, 204, "")
  end

  def call(%{method: "GET", request_path: "/__csp-reports"} = conn, _opts) do
    conn |> put_resp_content_type("application/json") |> send_resp(200, JSON.encode!(CspServe.Reports.all()))
  end

  def call(%{method: "DELETE", request_path: "/__csp-reports"} = conn, _opts) do
    CspServe.Reports.clear()
    send_resp(conn, 204, "")
  end

  def call(%{method: method} = conn, opts) when method in ["GET", "HEAD"] do
    dist = opts[:dist]
    rel = conn.path_info |> Enum.map(&URI.decode/1) |> Enum.join("/")
    file = Path.expand(rel, dist)
    inside = file == dist or String.starts_with?(file, dist <> "/")

    file =
      cond do
        inside and File.regular?(file) -> file
        inside and File.regular?(Path.join(file, "index.html")) -> Path.join(file, "index.html")
        # A single-page app: anything else is the app.
        true -> Path.join(dist, "index.html")
      end

    if Path.extname(file) == ".html" do
      {html, csp} = CspServe.Policy.for_page(opts[:policy], File.read!(file), opts[:file_hashes], style_nonce: opts[:style_nonce])

      conn
      |> put_resp_header("content-security-policy", csp)
      |> put_resp_header("content-security-policy-report-only", csp <> "; report-uri /__csp-report")
      |> put_resp_header("cache-control", "no-store")
      |> put_resp_content_type("text/html")
      |> send_resp(200, html)
    else
      conn
      |> put_resp_content_type(MIME.from_path(file), nil)
      |> put_resp_header("cache-control", "no-store")
      |> send_file(200, file)
    end
  end

  def call(conn, _opts), do: send_resp(conn, 405, "")
end

defmodule CspServe do
  def run(argv) do
    {opts, _} =
      OptionParser.parse!(argv, strict: [port: :integer, dist: :string, conf: :string, print: :boolean, style_nonce: :boolean])

    app = Path.expand("..", __DIR__)
    dist = Path.expand(opts[:dist] || Path.join(app, "dist"))
    conf = Path.expand(opts[:conf] || Path.join(app, "src-tauri/tauri.conf.json"))

    unless File.regular?(Path.join(dist, "index.html")) do
      IO.puts(:stderr, "no #{dist}/index.html: run `pnpm build` first (or pass --dist)")
      System.halt(1)
    end

    policy = CspServe.Policy.load_conf(conf)
    file_hashes = if CspServe.Policy.can_modify?(policy, "script-src"), do: CspServe.Policy.script_file_hashes(dist), else: []
    style_nonce = opts[:style_nonce] || false

    if opts[:print] do
      {_, csp} = CspServe.Policy.for_page(policy, File.read!(Path.join(dist, "index.html")), file_hashes, style_nonce: style_nonce)
      IO.puts(csp)
      System.halt(0)
    end

    port = opts[:port] || 4173
    plug_opts = [dist: dist, policy: policy, file_hashes: file_hashes, style_nonce: style_nonce]

    {:ok, _} =
      Supervisor.start_link(
        [CspServe.Reports, {Bandit, plug: {CspServe.Plug, plug_opts}, ip: {127, 0, 0, 1}, port: port}],
        strategy: :one_for_one
      )

    IO.puts("serving #{dist} with the release CSP on http://127.0.0.1:#{port} (#{length(file_hashes)} script hashes)")
    IO.puts("violations: GET http://127.0.0.1:#{port}/__csp-reports")
    Process.sleep(:infinity)
  end
end

CspServe.run(System.argv())
