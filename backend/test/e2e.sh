#!/usr/bin/env bash
BASE="https://slipscan-api.slipscanco.workers.dev"; TS=$(date +%s)
PASS=0; FAIL=0; FAILS=""
# Generate a test receipt image if missing (needs python3 + Pillow).
if [ ! -f /tmp/receipt.png ]; then
  python3 -c "from PIL import Image,ImageDraw; i=Image.new('RGB',(400,300),'white'); d=ImageDraw.Draw(i); d.text((20,20),'WOOLWORTHS PTY LTD',fill='black'); d.text((20,60),'Date: 2026-05-15',fill='black'); d.text((20,100),'Milk 29.99',fill='black'); d.text((20,180),'TOTAL ZAR 49.98',fill='black'); d.text((20,220),'VAT 6.52',fill='black'); i.save('/tmp/receipt.png')" 2>/dev/null || echo "(no Pillow; doc pipeline upload will fail)"
fi

TOK=""; C=""; B=""
j(){ printf '%s' "$1"|grep -o "\"$2\":\"[^\"]*\""|head -1|cut -d'"' -f4; }
api(){ local m=$1 p=$2 d=$3; local a=(-s -m 90 -X "$m" "$BASE$p" -H "Content-Type: application/json"); [ -n "$TOK" ]&&a+=(-H "Authorization: Bearer $TOK"); [ -n "$d" ]&&a+=(-d "$d"); local o; o=$(curl "${a[@]}" -w $'\n%{http_code}'); C=$(printf '%s' "$o"|tail -1); B=$(printf '%s' "$o"|sed '$d'); }
t(){ api "$2" "$3" "$5"; local ok=0; [ "$4" = "2xx" ]&&[[ "$C" =~ ^2 ]]&&ok=1; [ "$4" = "$C" ]&&ok=1; if [ $ok = 1 ];then printf 'PASS  %-44s %s\n' "$1" "$C"; PASS=$((PASS+1));else printf 'FAIL  %-44s got %s want %s\n' "$1" "$C" "$4"; FAIL=$((FAIL+1)); FAILS="$FAILS\n  $1 ($C/$4): $(printf '%s' "$B"|head -c 90)";fi; }

echo "===== AUTH ====="
t healthz GET /healthz 2xx
EM="ef+$TS@slipscan.test"; PW="e2etestpw123"
t register POST /auth/register 201 "{\"email\":\"$EM\",\"password\":\"$PW\"}"; TOK=$(j "$B" access_token); RF=$(j "$B" refresh_token)
t "register dup->409" POST /auth/register 409 "{\"email\":\"$EM\",\"password\":\"$PW\"}"
t login POST /auth/login 200 "{\"email\":\"$EM\",\"password\":\"$PW\"}"; TOK=$(j "$B" access_token)
t "login badpw->401" POST /auth/login 401 "{\"email\":\"$EM\",\"password\":\"wrongpw123\"}"
t refresh POST /auth/refresh 200 "{\"refresh_token\":\"$RF\"}"
t me GET /auth/me 2xx
t verify-resend POST /auth/verify/resend 2xx "{\"email\":\"$EM\"}"
t pwreset-request POST /auth/password-reset/request 2xx "{\"email\":\"$EM\"}"
echo "===== ORGS/INVITES ====="
t "create biz org" POST /orgs 201 '{"kind":"business","name":"F Biz","legal_name":"F Pty"}'; OB=$(j "$B" id)
t "create personal org" POST /orgs 201 '{"kind":"personal","name":"F P","full_name":"F"}'; OP=$(j "$B" id)
t "list orgs" GET /orgs 200
t "members" GET /orgs/$OB/members 200
t "invite create" POST /orgs/$OB/invitations 201 "{\"email\":\"i+$TS@x.com\",\"role\":\"member\"}"; INV=$(j "$B" id)
t "invites list" GET /orgs/$OB/invitations 200
t "invite resend" POST /orgs/$OB/invitations/$INV/resend 2xx ""
t "invite revoke" DELETE /orgs/$OB/invitations/$INV 2xx ""
t "non-member->403" GET /orgs/00000000-0000-0000-0000-000000000000/members 403
echo "===== LEDGER ====="
t "accounts list" GET /orgs/$OB/accounts 200; A1=$(printf '%s' "$B"|grep -o '"id":"[^"]*"'|sed -n '1p'|cut -d'"' -f4); A2=$(printf '%s' "$B"|grep -o '"id":"[^"]*"'|sed -n '2p'|cut -d'"' -f4)
t "create account" POST /orgs/$OB/accounts 2xx '{"code":"4999","name":"F Rev","type":"income","currency":"ZAR"}'
t "create contact" POST /orgs/$OB/contacts 2xx '{"name":"F Cust","kind":"customer"}'
t "balanced journal" POST /orgs/$OB/journals 2xx "{\"posted_date\":\"2026-05-01\",\"narration\":\"f\",\"lines\":[{\"account_id\":\"$A1\",\"debit\":\"100.00\",\"credit\":\"0\"},{\"account_id\":\"$A2\",\"debit\":\"0\",\"credit\":\"100.00\"}]}"
t "unbalanced journal->422" POST /orgs/$OB/journals 422 "{\"posted_date\":\"2026-05-01\",\"narration\":\"b\",\"lines\":[{\"account_id\":\"$A1\",\"debit\":\"100.00\",\"credit\":\"0\"},{\"account_id\":\"$A2\",\"debit\":\"0\",\"credit\":\"50.00\"}]}"
t "trial-balance" GET /orgs/$OB/trial-balance 200
t "journals list" GET /orgs/$OB/journals 200
echo "===== FINANCE ====="
t spending GET /orgs/$OP/spending 200
t net-worth GET /orgs/$OP/net-worth 200
t "net-worth history" GET /orgs/$OP/net-worth/history 200
t budgets GET /orgs/$OP/budgets 200
t goals GET /orgs/$OP/goals 200
t "create goal" POST /orgs/$OP/goals 2xx '{"name":"Fund","kind":"savings","target_amount":"1000.00","currency":"ZAR"}'
echo "===== REPORTING ====="
t "report P&L" GET "/orgs/$OB/reports/profit-and-loss?from=2026-01-01&to=2026-12-31" 200
t "report balance-sheet" GET "/orgs/$OB/reports/balance-sheet?from=2026-01-01&to=2026-12-31" 200
t "report vat-summary" GET "/orgs/$OB/reports/vat-summary?from=2026-01-01&to=2026-12-31" 200
t "report cash-flow" GET "/orgs/$OP/reports/cash-flow?from=2026-01-01&to=2026-12-31" 200
t "report CSV" GET "/orgs/$OB/reports/profit-and-loss?from=2026-01-01&to=2026-12-31&format=csv" 200
echo "===== DOC PIPELINE (R2 + Gemini) ====="
DOC=$(curl -s -m 90 -X POST "$BASE/orgs/$OB/documents" -H "Authorization: Bearer $TOK" -F "file=@/tmp/receipt.png;type=image/png" | j /dev/stdin id 2>/dev/null)
DOC=$(curl -s -m 90 -X POST "$BASE/orgs/$OB/documents" -H "Authorization: Bearer $TOK" -F "file=@/tmp/receipt.png;type=image/png" -w '\n%{http_code}' | sed '$d' | grep -o '"id":"[^"]*"'|head -1|cut -d'"' -f4)
echo "  doc=$DOC"
t "doc list" GET /orgs/$OB/documents 200
for i in 1 2 3 4 5; do api POST /orgs/$OB/documents/$DOC/extract; [ "$C" = 200 ]&&break; echo "  extract retry $i ($C)"; done
t "extract (Gemini)" POST /orgs/$OB/documents/$DOC/extract 2xx ""
t "classify (Gemini)" POST /orgs/$OB/documents/$DOC/classify 2xx ""
t "transactions" GET /orgs/$OB/transactions 200
echo "===== RECON/INTEL/INSIGHTS/AUDIT/TOKENS ====="
t "reconcile run" POST /orgs/$OB/reconcile 2xx ""
t "reconcile buckets" GET /orgs/$OB/reconcile 200
t forecast GET /orgs/$OB/forecast 200
t anomalies GET /orgs/$OB/anomalies 200
t tax-readiness GET /orgs/$OB/tax-readiness 200
t workspace GET /workspace 200
t "ask (Gemini)" POST /orgs/$OB/ask 2xx '{"question":"how much did I spend in total?"}'
t "audit list" GET /orgs/$OB/audit 200
t "api-token issue" POST /orgs/$OB/api-tokens 2xx '{"name":"f","kind":"test","scopes":["transactions:read"]}'; TID=$(j "$B" id); AK=$(j "$B" plaintext); [ -z "$AK" ]&&AK=$(j "$B" token)
t "api-token list" GET /orgs/$OB/api-tokens 200
if [ -n "$AK" ]; then V=$(curl -s -m 30 -o /dev/null -w "%{http_code}" "$BASE/v1/orgs/$OB/transactions" -H "Authorization: Bearer $AK"); [ "$V" = 200 ]&&{ echo "PASS  v1 API (token auth)                       200"; PASS=$((PASS+1)); }||{ echo "FAIL  v1 API $V"; FAIL=$((FAIL+1)); }; fi
t "api-token revoke" DELETE /orgs/$OB/api-tokens/$TID 2xx ""
echo "===== INTEGRATION GUARDS ====="
t "bankfeed connect->503" GET /orgs/$OB/integrations/bankfeed/connect 503
t "bankfeed connections" GET /orgs/$OB/integrations/bankfeed/connections 200
t "xero status->503 (unconfigured)" GET /orgs/$OB/integrations/xero/status 503
t "xero connect->503" GET /orgs/$OB/integrations/xero/connect 503
echo; echo "############ FINAL: PASS=$PASS FAIL=$FAIL ############"
[ $FAIL -gt 0 ]&&printf 'FAILURES:%b\n' "$FAILS"
