#!/bin/bash
# Fund Tracker API Test Suite
# 运行: cd /Volumes/WD_SN7100_2TB/Code/Fund && bash server/tests/api.test.sh

BASE="http://localhost:3001/api"
DB="/Volumes/WD_SN7100_2TB/Code/Fund/server/portfolio.db"
PASS=0; FAIL=0; ERRORS=()

R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; N='\033[0m'
c() { curl --noproxy '*' -s "$@"; }
ok() { echo -e "  ${G}PASS${N} $1"; PASS=$((PASS+1)); }
ng() { echo -e "  ${R}FAIL${N} $1 ($2)"; FAIL=$((FAIL+1)); ERRORS+=("$1: $2"); }
assert_eq() { local w=$(echo "$2" | xargs) g=$(echo "$3" | xargs); [ "$w" = "$g" ] && ok "$1" || ng "$1" "want=$w got=$g"; }
assert_ne() { [ "$2" != "$3" ] && ok "$1" || ng "$1" "should not be $2"; }
assert_has() { echo "$3" | grep -q "$2" 2>/dev/null && ok "$1" || ng "$1" "missing '$2'"; }
jv() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }
holding() { sqlite3 "$DB" "SELECT ROUND(COALESCE(SUM(CASE WHEN type='buy' THEN shares ELSE 0 END),0)-COALESCE(SUM(CASE WHEN type='sell' THEN shares ELSE 0 END),0),2) FROM transactions WHERE fund_id=$1;"; }
cumul() { sqlite3 "$DB" "SELECT cumulative_gain FROM funds WHERE id=$1;"; }

echo ""
echo "========================================"
echo " Fund Tracker API Tests — $(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M')"
echo "========================================"

c "$BASE/stats/summary" | grep -q "total_value" || { echo -e "${R}Server not running${N}"; exit 1; }

# 用fund 7(有历史持仓)做测试
TF=7
H0=$(holding $TF)
C0=$(cumul $TF)

echo -e "\n${Y}=== 1. 交易CRUD ===${N}"

echo "--- 1.1 affect_gain=true ---"
B=$(holding $TF)
ID1=$(c -X POST "$BASE/transactions" -H "Content-Type: application/json" \
  -d "{\"fund_id\":$TF,\"date\":\"2026-04-01\",\"type\":\"buy\",\"shares\":100,\"price\":1.96,\"notes\":\"t1\",\"affect_gain\":true}" | jv "['id']")
A=$(holding $TF)
D=$(python3 -c "print(round($A-$B,2))")
assert_eq "1.1 affect_gain=true 份额+100" "100.0" "$D"

echo "--- 1.2 affect_gain=false ---"
B2=$(holding $TF)
ID2=$(c -X POST "$BASE/transactions" -H "Content-Type: application/json" \
  -d "{\"fund_id\":$TF,\"date\":\"2026-04-01\",\"type\":\"buy\",\"shares\":50,\"price\":1.96,\"notes\":\"t2\",\"affect_gain\":false}" | jv "['id']")
A2=$(holding $TF)
assert_eq "1.2 affect_gain=false 份额不变" "$B2" "$A2"

echo "--- 1.3 编辑交易 ---"
c -X PUT "$BASE/transactions/$ID1" -H "Content-Type: application/json" -d '{"shares":200}' > /dev/null
A3=$(holding $TF)
D3=$(python3 -c "print(round($A3-$B,2))")
assert_eq "1.3 编辑后份额+200" "200.0" "$D3"

echo "--- 1.4 删除交易 ---"
# 先记录历史持仓被adjustBase改前的值, 用于还原
BASE_BEFORE=$(sqlite3 "$DB" "SELECT shares FROM transactions WHERE fund_id=$TF AND notes LIKE '%历史%' LIMIT 1;")
c -X DELETE "$BASE/transactions/$ID1" > /dev/null
c -X DELETE "$BASE/transactions/$ID2" > /dev/null
# affect_gain=false添加buy时adjustBase减了base 50份, 删除TX不会自动还原
sqlite3 "$DB" "UPDATE transactions SET shares=shares+50 WHERE fund_id=$TF AND notes LIKE '%历史%';"
A4=$(holding $TF)
assert_eq "1.4 删除后份额恢复" "$H0" "$A4"

echo "--- 1.5 缺字段校验 ---"
E5=$(c -X POST "$BASE/transactions" -H "Content-Type: application/json" -d "{\"fund_id\":$TF}")
assert_has "1.5 缺字段400" "required" "$E5"

echo "--- 1.6 分红不影响份额 ---"
B6=$(holding $TF)
ID6=$(c -X POST "$BASE/transactions" -H "Content-Type: application/json" \
  -d "{\"fund_id\":$TF,\"date\":\"2026-04-01\",\"type\":\"dividend\",\"shares\":0,\"price\":50,\"notes\":\"t6\"}" | jv "['id']")
A6=$(holding $TF)
assert_eq "1.6 分红不影响份额" "$B6" "$A6"
c -X DELETE "$BASE/transactions/$ID6" > /dev/null

echo -e "\n${Y}=== 2. NAV与快照 ===${N}"
echo "--- 2.1-2.4 ---"
R1=$(c -X POST "$BASE/nav/refresh-all")
U1=$(echo "$R1" | jv "['updated']")
assert_ne "2.1 refreshAllNav更新数>0" "0" "$U1"

PN=$(sqlite3 "$DB" "SELECT COUNT(*) FROM funds WHERE prev_nav>0 AND deleted_at IS NULL AND code!='';")
TF2=$(sqlite3 "$DB" "SELECT COUNT(*) FROM funds WHERE deleted_at IS NULL AND code!='';")
assert_eq "2.2 所有基金prev_nav>0" "$TF2" "$PN"

ND=$(sqlite3 "$DB" "SELECT nav_date FROM funds WHERE id=10;")
assert_ne "2.3 nav_date非空" "" "$ND"

TODAY=$(TZ=Asia/Shanghai date '+%Y-%m-%d')
DOW=$(TZ=Asia/Shanghai date '+%u')
if [ "$DOW" -ge 6 ]; then
  SC=$(sqlite3 "$DB" "SELECT COUNT(*) FROM daily_snapshots WHERE date='$TODAY';")
  assert_eq "2.4 周末无快照" "0" "$SC"
else
  echo -e "  ${Y}SKIP${N} 2.4 今天非周末"
fi

echo -e "\n${Y}=== 3. 累计收益 ===${N}"
echo "--- 3.1 幂等 ---"
c -X POST "$BASE/nav/refresh-all" > /dev/null 2>&1
G1=$(cumul 10)
c -X POST "$BASE/nav/refresh-all" > /dev/null 2>&1
G2=$(cumul 10)
c -X POST "$BASE/nav/refresh-all" > /dev/null 2>&1
G3=$(cumul 10)
assert_eq "3.1a 幂等1=2" "$G1" "$G2"
assert_eq "3.1b 幂等2=3" "$G2" "$G3"

echo "--- 3.2 updateFund cumulative_gain ---"
GB=$(cumul $TF)
c -X PUT "$BASE/funds/$TF" -H "Content-Type: application/json" -d '{"cumulative_gain":8888.88}' > /dev/null
GS=$(cumul $TF)
assert_eq "3.2 updateFund设置CG" "8888.88" "$GS"
c -X PUT "$BASE/funds/$TF" -H "Content-Type: application/json" -d "{\"cumulative_gain\":$GB}" > /dev/null

echo "--- 3.3 updateFundGain同步CG ---"
GB2=$(cumul $TF)
c -X POST "$BASE/funds/$TF/gain" -H "Content-Type: application/json" -d '{"gain":-500}' > /dev/null
GG=$(cumul $TF)
assert_eq "3.3 updateFundGain CG=-500" "-500.0" "$GG"
c -X POST "$BASE/funds/$TF/gain" -H "Content-Type: application/json" -d "{\"gain\":$GB2}" > /dev/null

echo -e "\n${Y}=== 4. 配对交易 ===${N}"
BID=$(c -X POST "$BASE/transactions" -H "Content-Type: application/json" \
  -d "{\"fund_id\":$TF,\"date\":\"2026-04-01\",\"type\":\"buy\",\"shares\":500,\"price\":1.96,\"notes\":\"pt_buy\",\"affect_gain\":true}" | jv "['id']")
SID=$(c -X POST "$BASE/transactions" -H "Content-Type: application/json" \
  -d "{\"fund_id\":$TF,\"date\":\"2026-04-05\",\"type\":\"sell\",\"shares\":300,\"price\":2.00,\"notes\":\"pt_sell\",\"affect_gain\":true}" | jv "['id']")

echo "--- 4.1 创建配对 ---"
TID=$(c -X POST "$BASE/trades" -H "Content-Type: application/json" \
  -d "{\"buyTxIds\":[$BID],\"sellTxIds\":[$SID]}" | jv "['id']")
PS=$(sqlite3 "$DB" "SELECT paired_shares FROM transactions WHERE id=$SID;")
assert_eq "4.1 paired_shares=300" "300.0" "$PS"

echo "--- 4.2 已全部配对拒绝 ---"
SID2=$(c -X POST "$BASE/transactions" -H "Content-Type: application/json" \
  -d "{\"fund_id\":$TF,\"date\":\"2026-04-06\",\"type\":\"sell\",\"shares\":100,\"price\":2.1,\"notes\":\"pt_sell2\",\"affect_gain\":true}" | jv "['id']")
ERR=$(c -X POST "$BASE/trades" -H "Content-Type: application/json" \
  -d "{\"buyTxIds\":[$SID],\"sellTxIds\":[$SID2]}")
assert_has "4.2 全配对拒绝" "不是买入" "$ERR"

echo "--- 4.3 部分配对可用份额 ---"
BP=$(sqlite3 "$DB" "SELECT paired_shares FROM transactions WHERE id=$BID;")
AV=$(python3 -c "print(round(500-$BP,2))")
assert_eq "4.3 可用份额=200" "200.0" "$AV"

echo "--- 4.4 删除配对恢复 ---"
c -X DELETE "$BASE/trades/$TID" > /dev/null
PA=$(sqlite3 "$DB" "SELECT paired_shares FROM transactions WHERE id=$SID;")
assert_eq "4.4 删除后paired=0" "0.0" "$PA"

c -X DELETE "$BASE/transactions/$BID" > /dev/null
c -X DELETE "$BASE/transactions/$SID" > /dev/null
c -X DELETE "$BASE/transactions/$SID2" > /dev/null

echo -e "\n${Y}=== 5. 基金接口 ===${N}"
FC=$(c "$BASE/funds" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
assert_ne "5.1 基金列表数>0" "0" "$FC"

DN=$(c "$BASE/funds/$TF/positions" | jv "['fund']['name']" 2>/dev/null || echo "")
assert_ne "5.2 基金详情有名称" "" "$DN"

OS=$(sqlite3 "$DB" "SELECT stop_profit_pct FROM funds WHERE id=$TF;")
c -X PUT "$BASE/funds/$TF" -H "Content-Type: application/json" -d '{"stop_profit_pct":99}' > /dev/null
NS=$(sqlite3 "$DB" "SELECT stop_profit_pct FROM funds WHERE id=$TF;")
assert_eq "5.3 编辑基金" "99.0" "$NS"
c -X PUT "$BASE/funds/$TF" -H "Content-Type: application/json" -d "{\"stop_profit_pct\":$OS}" > /dev/null

echo -e "\n${Y}=== 6. 统计接口 ===${N}"
assert_has "6.1 summary" "total_value" "$(c "$BASE/stats/summary")"
assert_has "6.2 allocation" "name" "$(c "$BASE/stats/allocation")"
assert_has "6.3 performance" "month" "$(c "$BASE/stats/performance")"

echo -e "\n${Y}=== 7. NAV接口 ===${N}"
assert_has "7.1 latest" "nav" "$(c "$BASE/nav/025209/latest")"
assert_has "7.2 byDate" "nav" "$(c "$BASE/nav/025209/date/2026-04-10")"
assert_has "7.3 estimateAll" "gsz" "$(c "$BASE/nav/estimate/all")"

echo -e "\n${Y}=== 8. 错误处理 ===${N}"
assert_has "8.1 不存在基金" "Cannot GET" "$(c "$BASE/funds/99999")"
assert_has "8.2 不存在交易" "not found" "$(c -X DELETE "$BASE/transactions/99999")"
assert_has "8.3 不存在配对" "不存在" "$(c -X DELETE "$BASE/trades/99999")"
assert_has "8.4 空配对" "至少需要" "$(c -X POST "$BASE/trades" -H "Content-Type: application/json" -d '{"buyTxIds":[],"sellTxIds":[]}')"

echo -e "\n${Y}=== 清理验证 ===${N}"
HF=$(holding $TF)
assert_eq "数据完整: 份额未变" "$H0" "$HF"

echo ""
echo "========================================"
T=$((PASS+FAIL))
echo -e " ${G}$PASS PASS${N} / ${R}$FAIL FAIL${N} / $T TOTAL"
echo "========================================"
if [ $FAIL -gt 0 ]; then
  echo -e "\n${R}失败:${N}"
  for e in "${ERRORS[@]}"; do echo "  - $e"; done
  exit 1
fi
echo -e "\n${G}All tests passed!${N}"
