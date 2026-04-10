#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="${TEST_DIR:-"$ROOT_DIR/arquivos-teste"}"
MODEL="${OPENAI_TRANSCRIPTION_MODEL:-gpt-4o-transcribe}"
PROMPT="${OPENAI_TRANSCRIPTION_PROMPT:-}"
API_KEY="${OPENAI_API_KEY:-}"

if [[ -z "$API_KEY" ]]; then
  echo "Erro: defina OPENAI_API_KEY antes de executar este script." >&2
  exit 1
fi

if [[ ! -d "$TEST_DIR" ]]; then
  echo "Erro: diretório não encontrado: $TEST_DIR" >&2
  exit 1
fi

shopt -s nullglob

files=(
  "$TEST_DIR"/*.mp3
  "$TEST_DIR"/*.m4a
  "$TEST_DIR"/*.wav
  "$TEST_DIR"/*.webm
  "$TEST_DIR"/*.mp4
  "$TEST_DIR"/*.ogg
)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "Nenhum arquivo de áudio ou vídeo encontrado em: $TEST_DIR" >&2
  exit 0
fi

extract_text() {
  python3 - "$1" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

text = data.get("text", "")
if isinstance(text, str):
    print(text.strip())
else:
    print("")
PY
}

for file in "${files[@]}"; do
  base_name="$(basename "$file")"
  out_txt="$TEST_DIR/${base_name%.*}.transcript.txt"
  out_json="$TEST_DIR/${base_name%.*}.transcript.json"

  echo "Transcrevendo: $base_name"

  response_tmp="$(mktemp)"
  curl_args=(
    -sS
    -o "$response_tmp"
    -w '%{http_code}'
    https://api.openai.com/v1/audio/transcriptions
    -H "Authorization: Bearer $API_KEY"
    -F "file=@$file"
    -F "model=$MODEL"
  )
  if [[ -n "$PROMPT" ]]; then
    curl_args+=(-F "prompt=$PROMPT")
  fi

  set +e
  http_code="$(curl "${curl_args[@]}")"
  curl_exit_code=$?
  set -e

  if [[ $curl_exit_code -ne 0 ]]; then
    echo "Falha de rede ou de transporte ao transcrever $base_name." >&2
    cat "$response_tmp" >&2
    rm -f "$response_tmp"
    continue
  fi

  if [[ "$http_code" != "200" ]]; then
    echo "Falha ao transcrever $base_name (HTTP $http_code)." >&2
    cat "$response_tmp" >&2
    rm -f "$response_tmp"
    continue
  fi

  cp "$response_tmp" "$out_json"
  text="$(extract_text "$response_tmp")"
  printf '%s\n' "$text" | tee "$out_txt"
  rm -f "$response_tmp"

  echo "Salvo em: $out_txt"
  echo "Resposta bruta em: $out_json"
  echo
done
