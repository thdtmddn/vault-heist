'use strict';
// 보상 계산 (서버와 테스트가 함께 사용)
// 보상은 캔디. 예전 죄수의 딜레마 앱과 같은 표를 씀.
// payoff 키는 "내 선택 + 상대 선택":
//   CC: 둘 다 협력일 때 나        (기본 3)
//   CD: 나는 협력, 상대는 배반     (기본 0)
//   DC: 나는 배반, 상대는 협력     (기본 5)
//   DD: 둘 다 배반일 때 나        (기본 1)
function computePayout(choices, payoff) {
  const a = choices[0], b = choices[1];
  const out = [payoff[a + b], payoff[b + a]];
  return { outcome: a + b, payout: out, total: out[0] + out[1] };
}
module.exports = { computePayout };
