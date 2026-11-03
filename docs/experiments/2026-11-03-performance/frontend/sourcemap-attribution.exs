#!/usr/bin/env elixir
# Attributes the minified bytes of a built chunk to the source modules (grouped by npm package)
# using its source map. Usage: elixir sourcemap-attribution.exs path/to/chunk.js [top_n]
# Build the chunks with: npx vite build --sourcemap --outDir <dir>

defmodule VLQ do
  import Bitwise
  @chars ~c"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  @map @chars |> Enum.with_index() |> Map.new()

  def decode(str), do: decode(String.to_charlist(str), 0, 0, [])
  defp decode([], _, _, acc), do: Enum.reverse(acc)

  defp decode([c | rest], shift, value, acc) do
    d = Map.fetch!(@map, c)
    value = value + ((d &&& 31) <<< shift)

    if (d &&& 32) != 0 do
      decode(rest, shift + 5, value, acc)
    else
      v = if (value &&& 1) == 1, do: -(value >>> 1), else: value >>> 1
      decode(rest, 0, 0, [v | acc])
    end
  end
end

defmodule Attr do
  def run([js | rest]) do
    top = case rest do
      [n | _] -> String.to_integer(n)
      _ -> 25
    end

    map = JSON.decode!(File.read!(js <> ".map"))
    lines = js |> File.read!() |> String.split("\n")
    sources = map["sources"] |> List.to_tuple()

    {bytes, _} =
      map["mappings"]
      |> String.split(";")
      |> Enum.zip(lines)
      |> Enum.reduce({%{}, 0}, fn {segs, line}, {acc, src} ->
        len = byte_size(line)

        {points, src} =
          segs
          |> String.split(",", trim: true)
          |> Enum.reduce({[], src}, fn seg, {pts, src} ->
            case VLQ.decode(seg) do
              [col | [ds | _]] -> {[{col, src + ds} | pts], src + ds}
              [col] -> {[{col, :none} | pts], src}
            end
          end)

        # columns are relative within a line
        {abs, _} =
          points
          |> Enum.reverse()
          |> Enum.map_reduce(0, fn {dc, s}, c -> {{c + dc, s}, c + dc} end)

        acc =
          abs
          |> Enum.chunk_every(2, 1)
          |> Enum.reduce(acc, fn
            [{c, s}, {n, _}], a -> Map.update(a, s, n - c, &(&1 + n - c))
            [{c, s}], a -> Map.update(a, s, max(len - c, 0), &(&1 + max(len - c, 0)))
          end)

        {acc, src}
      end)

    total = File.stat!(js).size

    by_pkg =
      bytes
      |> Enum.group_by(fn {s, _} -> pkg(s, sources) end, fn {_, b} -> b end)
      |> Enum.map(fn {k, v} -> {k, Enum.sum(v)} end)
      |> Enum.sort_by(fn {_, b} -> -b end)

    IO.puts("# #{Path.basename(js)}  total #{kb(total)} kB\n")
    IO.puts("| package / dir | kB (minified) | % |")
    IO.puts("|---|---:|---:|")

    for {k, b} <- Enum.take(by_pkg, top) do
      IO.puts("| #{k} | #{kb(b)} | #{Float.round(b * 100 / total, 1)} |")
    end
  end

  defp pkg(:none, _), do: "(unmapped)"

  defp pkg(i, sources) when i < tuple_size(sources) do
    s = elem(sources, i)
    # DETAIL=1 lists the app's own files one by one instead of by directory
    detail = System.get_env("DETAIL") != nil

    case Regex.run(~r{node_modules/(?:\.pnpm/[^/]+/node_modules/)?((?:@[^/]+/)?[^/]+)}, s) do
      [_, p] -> p
      _ when detail -> s |> String.replace(~r{^.*?/app/}, "")
      _ -> s |> String.replace(~r{^.*?/app/}, "") |> Path.dirname()
    end
  end

  defp pkg(_, _), do: "(unmapped)"
  defp kb(b), do: Float.round(b / 1000, 1)
end

Attr.run(System.argv())
