# 배포 이미지와 한글 글꼴

**제작 기준 · 2026-11-26.** 문양 넷, 숫자 열 개, 등판의 겹친 C를 각각 Codex image generation 한 호출로 생성한다. 출시용 앞면 60종은 이 세 원본 세트에서 나온다. 장면과 DOM은 같은 PNG 주소와 셀 좌표를 사용한다. 생성 시안 네 장은 디자인 자료이며 배포 manifest에 넣지 않는다.

## 배포 파일

아래 파일의 저장소 디렉터리는 모두 `apps/web/public/art/`, 브라우저 경로는 `/art/`이다. 좌표는 PNG 좌상단 기준, 사각형은 왼쪽·위 포함, 오른쪽·아래 제외다. 크기·셀 위치는 Q2 최종 manifest와 대조해 확정했다. 제품에는 아틀라스 둘만 배포한다.

| 파일 | 원본 크기 | 내용·셀 | 허용 색과 알파 |
| --- | ---: | --- | --- |
| atlas-wide.png | 420×186 | 15열×4행, x=28(number−1), y=40suitRank. 각 28×40. (0,160,20,26)에 공용 등판, 마지막 행의 나머지는 투명 | 앞면별 paper·ink·pine·해당 문양색 하나. 등판만 램프 4톤. 알파 0/255 |
| atlas-compact.png | 360×160 | 같은 열·행 순서, x=24(number−1), y=40suitRank, 각 24×40. 같은 숫자와 문양 마스크 | 앞면별 paper·ink·pine·해당 문양색 하나. 알파 0/255 |

팔레트와 숫자 칸의 규격은 [시각 명세 §1~3](visual-spec.md)에 있다. 두 PNG 합계 ≤50,000바이트, 한 변 ≤512px. 프레임 크기와 무관한 애플리케이션 경로이며 Vite public에서 dist로 복사한다. 네트워크 실패 시에도 타일 이름과 수치를 DOM 글자로 표시한다.

Q2 후보 5개 합계는 2517B다. bayer-2.png(128B), bayer-5.png(132B), bayer-8.png(129B)는 Q1의 DOM 단색 결정에 따라 검사용으로만 보관한다. Q2 원본을 처리한 두 아틀라스는 각각 1173B·955B(합계 2128B)였다. 숫자 0..9, 구름·별·달·해, 등판 마크의 수정 픽셀 수는 각각 0이다. 숫자의 가로·세로 최소 획 2 이상, 해의 연결 성분은 36·5·5·4·4·4·4·4·4px였다. 제품 판정 파일은 `design/assets/manifest.json`이다. `files`는 배포 PNG 두 항목의 배열로 각 항목에 `{url,path,width,height,bytes,sha256,allowedColors,alpha}`를 둔다. path는 저장소 루트 상대 경로, url은 /art/ 절대 경로, sha256은 소문자 64자리다. `cells`는 원본 15셀의 `{id,foreground,overrideCount}` 배열이며 foreground는 수정 전 전경 수다. 배포 파일은 manifest의 bytes·sha256과 일치해야 한다. 같은 Q2 입력·인코더이면 1173/955B와 Q2 출력 해시까지 일치해야 한다. 원본·인코더를 바꾼 경우 새 출처·재생성 검사·Q2 비교를 기록하고 승인된 계약 변경 입력에서 manifest를 함께 갱신한다.

### 생성 원본 세트

`design/assets/raw/{suits,digits,back}.png`와 각 후보의 프롬프트 전문·UTC 또는 KST 날짜/시간·도구·출력 크기·선택 번호·해시를 `design/assets/raw/provenance.json`에 기록한다. 아래 지시를 그대로 기본 프롬프트로 사용하고 추가 지시도 저장한다. 실패하면 해당 세트 전체를 다시 생성한다.

| 원본 | Codex에 지시할 그림 | 정리본(제품에 미포함) |
| --- | --- | --- |
| suits | 순백 키 바탕에 순검정 실루엣 2열×2행. 동일한 광학 크기와 수평 기준선. 위 왼쪽부터 행 우선으로 밑이 평평한 세 봉우리 구름, 속 찬 다섯 꼭짓점 별, 오른쪽이 열린 초승달, 분리된 여덟 살과 원반의 해. 글자·경계선·음영·장식 없음. | mask-suits.png 64×14, 셀 16×14. 가시 폭≥14, 높이≥12. |
| digits | 순백 바탕에 검정 픽셀 숫자 0~9를 읽는 순서로 5열×2행. 동일한 높이·기준선, 굵은 직교 획, 0·6·8·9 속공간을 열어 둔다. 1·7·3·8 구별. 그림자·장식·다른 기호 없음. | mask-digits.png 90×13, 9×13 셀 열 개를 0..9 순서로 재배치. |
| back | 순백 단색 배경, 가운데 계단형 C 두 개가 어긋나 겹친 검정 마크 하나. 글자·숫자·문양·테두리·체커 없이 정면. 12×12 마스크로 축소해도 끝의 계단이 보이는 단순 실루엣. | mask-back.png 12×12. 20×26 등판의 (4,6)에 합성. |

W1 시작 전에 게시할 디자인 커밋의 [Q2 인수 자료](q2-source/)가 기준이다. cb346a1fda7715478ffe4f88707a92a898294782의 design/q2-assets에서 Git blob 단위로 복사한 raw/digits.png(1774×887), raw/suits.png(1341×1173), raw/back.png(1254×1254)가 정확한 생성 입력이다. Q2 기록의 시각 정밀도는 2026-11-26 KST 날짜까지이며 각 한 번 생성해 첫 후보 1/1을 택했다. 새 후보에는 호출 시각까지 기록한다. 같은 디렉터리 provenance.json의 프롬프트 전문과 원본을 함께 인수한다. 보관한 gate 스크립트는 `docs/design/q2-source/run.ts`, 검사는 `assets.test.ts`이며 독립 2회 실행한 출력 27개의 SHA-256이 모두 같았다.

### 원본 → 마스크 → 배포본

W2 asset-production은 게시된 W1 기준 SHA에서 `docs/design/q2-source/`를 읽는다. 그 디렉터리에서 `shasum -a 256 -c inputs.sha256`(입력 10파일)과 `shasum -a 256 -c hashes.sha256`(출력 27파일)을 확인한다. 첫 커밋에서 raw/·overrides.json·hashes.sha256·inputs.sha256을 design/assets/로, run.ts와 assets.test.ts를 같은 fence의 build.ts와 build.test.ts의 출발본으로, font/ 두 파일을 apps/web/public/fonts/로 인수한다. 변환 전 blob은 게시된 입력과 `git hash-object`로 대조한다. 원래 provenance 항목은 보존하고 제품 raw/provenance.json의 각 항목에 게시된 inputs.sha256의 해당 sha256을 덧붙인다. 제품 마스크 3개는 `design/assets/outputs/mask-{suits,digits,back}.png`에 커밋한다. Q2 체크섬은 인수 자료 검증용이며 제품 스크립트·보강한 provenance의 현재 해시는 제품 기록에서 따로 관리한다. docs/design/q2-source/는 일정 전체에서 읽기 전용이며 새 clone도 로컬 실험 브랜치 없이 재현할 수 있다. 변환 진입점은 `bun design/assets/build.ts` 하나다. 원본과 변환 결과, 사람이 볼 1배·정수배 대조 시트, 셀별 전경·수정 수를 함께 보관한다. 운영 이미지에는 배포 파일만 복사한다.

1. Bun에서 PNG 서명·청크 CRC·IHDR를 검사하고 IDAT를 연결해 `node:zlib`로 inflate한다. 원본 3개는 bit depth 8, RGB(color type 2), interlace 0이다. 행마다 필터 0..4(None/Sub/Up/Average/Paeth)를 3바이트 픽셀 기준으로 역산한다. 다른 포맷·필터·행 길이는 오류다. 복원한 RGB를 고정 열·행 순서로 분할한다. R+G+B<384를 검정 전경으로 잡고 그 bounding box를 각 목표 셀로 맞춘다. 타일 숫자 기준선은 셀 하단이다. RGB 원본을 제품에 직접 쓰지 않는다.
2. 대상 texel마다 원본 전경과 겹치는 면적의 합을 구해 절반 이상이면 1, 아니면 0. 1은 지정 잉크/불투명, 0은 투명. PNG의 테두리 앤티앨리어싱·원본 배경·중간톤을 제거한다. 원본 알파에 의존하지 않는다.
3. 셀별 원시 마스크와 `design/assets/overrides.json`의 {cell,x,y,value}를 대조한다. 변경 좌표 중복·범위 밖·동일값 덮어쓰기 금지. 서로 다른 변경 픽셀 수 ≤floor(수정 전 전경 픽셀 수/10). 한도 초과 시 해당 원본 세트 전체를 Codex로 재생성한다. 새 후보의 출처를 기록하고 마스크 검사부터 다시 실행한다. 원시 마스크의 중복·숫자 획·광선 분리를 먼저 검사하고, 수정 후 같은 검사를 다시 수행한다. 두 자리 점유 폭은 19px, 사이 빈 열은 1px다.
4. W=28 또는 24. 외곽을 ink로 채우고 네 모서리 1픽셀은 투명. (1,1,W−2,34) paper, y=35 ink 선, (1,36,W−2,3) pine, y=39 ink. 숫자 중앙 x=floor((W−(10×자릿수−1))/2), y=3, 10px 피치. 문양은 x=(W−16)/2, y=19. 등판 바깥 ink, (1,1,18,24) pine, (2,2,16,21) sage, 그 안의 1px 둘레에 (x+y)가 짝수일 때 paper 체커. 표식 ink. 와이드 DOM 폴백의 상대 등판과 대조 시트만 체커를 사용한다. B의 경사진 등판은 sage 면·ink 테두리, 컴팩트의 상대는 장수 텍스트다.
5. 팔레트 상수와 Bayer 순위로 4×4 검사용 타일 3종(bayer-2/5/8.png)을 design/assets 검사 산출물에만 생성한다. 좌상단 기준 행 순서로 pine 2/5/8칸, 나머지 ink, alpha 255. Q1에 따라 제품 DOM 배경은 ink 단색이다. PNG를 고정 포맷·필터·압축 단계로 인코딩하고 시각/출처 명세, 바이트 수, SHA-256을 결과에 기록한다. 같은 SHA의 원본·스크립트·도구에서 2회 실행해 결과 파일 해시가 전부 동일해야 한다.

**도구 확인.** 현장 Bun 1.3.6, Chrome 158.0.8127.89, Python 3.10.11/Pillow 12.0.0 확인. 보관된 Q2 스크립트는 원본·조판에 headless Chrome을 썼다. 제품 build.ts와 검사는 위 RGB 행 복원·indexed PNG 인코딩을 Bun 내장 node:zlib로 수행한다. Chrome은 대조 시트·브라우저 캡처에만 쓴다. npm 의존성 추가 없음. 제품 gate에서는 Bun으로 커밋된 PNG 청크 CRC를 검증하고 IDAT를 풀어 행 필터·PLTE/tRNS를 적용해 실제 픽셀을 검사한다. Chrome, Python, Pillow, GPU와 생성 호출은 제품 gate·Docker 빌드에 필요하지 않다.

**자동 검사.** `bun test design/assets`는 세 raw PNG의 SHA-256을 제품 provenance 및 게시된 원본 체크섬과 대조한다. 원본+overrides에서 15셀 마스크와 배포 PNG 둘을 메모리에 새로 생성한다. 수정 좌표 중복/범위/동일값·floor(foreground/10) 상한 및 cells 기록을 다시 계산하고 세 커밋 마스크와 두 배포 PNG를 바이트 단위 대조한다. 기본 입력에서는 Q2 hashes.sha256의 해당 5항목과도 같아야 한다. asset-production, integrate-modules와 verify-release가 각 HEAD에서 이 명령을 독립 실행한다. manifest의 각 파일이 존재하고 이름 목록·크기·예산·SHA가 맞아야 한다. 각 texel은 alpha∈{0,255}, 비투명 색은 해당 셀의 허용 집합에 속해야 한다. 꼭짓점과 unused 영역의 알파는 0, 몸체·등판 내부는 255. 글리프 영역에서는 해당 마스크 밖 paper, 안쪽은 정확히 ink 또는 해당 문양색이다. 아틀라스별 60쌍 모두 다르고, 와이드·컴팩트에서 추출한 같은 패의 숫자·문양 마스크가 일치해야 한다. 0..9의 10개 마스크는 비어 있지 않고 서로 다르며, 모든 행·열의 비어 있지 않은 연속 획 길이 ≥2. 네 문양 해시가 다르고 해의 8방향 연결 성분은 큰 원반 1+분리된 살 8. 등판은 숫자나 문양 셀과 다르다. Bayer는 각 위치를 CPU 임곗값과 대조하고 점유율 2/5/8칸을 확인한다. 작업자는 회색조·단일 잉크 시트 결과를 기록한다. 소유자 개인의 1배·정수배 판독은 게시 후 체크로 남긴다.

**코드 도형.** 펠트·그림자·테두리·바닥·받침·칩 잔액·차례선·포커스·버튼·패널은 메시/CSS/DOM이다. 앞면 몸체와 등판 체커는 스크립트가 생성 원본 마스크에 더한 기하다. 각 4×4 Bayer 테스트 PNG는 도구의 대조 시트 전용이다. 오디오 파일·워드마크 이미지·전체 화면 배경 파일은 배포 목록에 없다.

## 글꼴

2026-11-26에 Q3에서 실제로 로드한 제작자 저장소 커밋 71e1cacf1437a11220307120e63e30bc275312d4의 폰트·OFL 파일을 확인했다. 측정한 글리프 폭을 재현하기 위해 이 바이트를 그대로 배포한다. Galmuri11 Regular 원본 WOFF2만 사용한다. 저작권 표시는 **Copyright © 2019–2025 Lee Minseo**. SIL Open Font License 1.1은 앱과 함께 배포할 때 저작권 고지와 전문을 동봉하도록 한다. 원문은 Reserved Font Name의 정의와 수정본 이름에 관한 조건을 포함하지만 저작권 문장 뒤에 예약 이름을 따로 지정하지 않았다. 첫 방문 WOFF2 본문 505400B를 예산으로 채택하고 Q3 조판에 사용한 원본 전체를 배포한다. [제작자 저장소](https://github.com/quiple/galmuri) · [OFL 원문](https://github.com/quiple/galmuri/blob/71e1cacf1437a11220307120e63e30bc275312d4/ofl.md) · [측정한 WOFF2](https://github.com/quiple/galmuri/blob/71e1cacf1437a11220307120e63e30bc275312d4/dist/Galmuri11.woff2)

| 제작자 저장소 경로 | 저장소 → dist 상대 경로 | 바이트 | SHA-256 |
| --- | --- | ---: | --- |
| dist/Galmuri11.woff2 | apps/web/public/fonts/ → fonts/Galmuri11.woff2 | 505400 | 8bad9322b3340bfb5cb26cb00f4752bf4c8e7d1b526bb07205f4af458eebed31 |
| ofl.md | apps/web/public/fonts/ → fonts/ofl.md | 4266 | 9a9e5a342c430c3fcf01a408b680f4405d5bf4ac659c931be35f8a1b27ea69c9 |

W1 visual/assets.ts에 `/fonts/Galmuri11.woff2`와 `/fonts/ofl.md` 각각 `{url,bytes,sha256}`를 위 표 그대로 동결한다. 고정 URL의 `/fonts/*`와 `/art/*` 응답은 `Cache-Control: public, max-age=0, must-revalidate`, 본문의 SHA-256을 큰따옴표로 감싼 강한 ETag를 보낸다. 정확한 If-None-Match 재요청은 304·본문 0B다. http-runtime과 외부 probe가 검사한다.

루트 페이지에서 같은 출처 /fonts/Galmuri11.woff2를 as=font, type=font/woff2, crossorigin=anonymous로 preload한다. @font-face는 normal/400, font-display: swap. 대체는 시스템 한글 고딕(sans-serif). 상태·선택·제출·패스·순위는 폰트 요청 실패 시에도 DOM에 남는다. 워드마크도 소문자 caxio를 같은 글꼴로 조판한다. 이미지 예산에 WOFF2를 산입하지 않는다. dist 전체에서 확장자와 실제 파일 형식으로 이미지 목록을 수집해 /art/atlas-wide.png와 /art/atlas-compact.png 두 경로만 존재하는지 대조하고 보고서에 첨부한다. ARM64 이미지에서 같은 origin의 PNG·WOFF2·OFL 응답 200 및 원본과 동일한 해시를 확인한다.
