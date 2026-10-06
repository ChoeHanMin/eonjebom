# 언제봄

친구들이 각자 시간표를 올려 두면, **나와 특정 친구가 언제 함께 시간이 되는지** 색으로 보여 주고 추천해 주는 웹앱이에요.
[when2meet](https://www.when2meet.com/)과 비슷하지만 다음이 달라요.

- **캘린더 연동**: 구글 캘린더(삼성 캘린더는 구글 계정 동기화를 통해), iCal 구독 주소, `.ics` 파일에서 바쁜 시간을 자동으로 가져와요.
- **5단계 색상**: 🟩 아주 좋음 · 🟢 좋음 · 🟨 애매함 · 🟧 웬만하면 안 됨 · 🟥 안 됨 (+ 미입력 회색)
- **계정과 친구 목록**: 한 번 올려 둔 시간표로 어떤 친구와도 바로 비교할 수 있어요.

## 주요 기능

| 화면 | 설명 |
| --- | --- |
| 언제봄 | 친구(여러 명 가능)를 고르면 주간 격자에 '모두 중 가장 안 되는 사람' 기준 색을 보여 주고, 함께 되는 시간을 좋은 순으로 추천해요. 칸을 누르면 사람별 상태가 보여요. |
| 기본 시간표 | 매주 반복되는 시간표(수업, 알바 등)를 색을 골라 드래그해서 칠해요. 자동 저장돼요. |
| 날짜별 일정 | 기본 시간표 + 캘린더 일정이 합쳐진 실제 일정이에요. 특정 날짜만 다른 칸은 직접 칠해서 덮어써요. |
| 친구 | 아이디로 친구 요청 → 수락. 서로 요청하면 자동으로 친구가 돼요. |
| 캘린더 연동 | 구글 캘린더 OAuth, iCal 주소, `.ics` 파일. 캘린더마다 "일정이 있는 시간을 어떤 색으로 볼지"(기본: 안 됨) 정할 수 있어요. |

### 한 칸의 색이 정해지는 순서

1. 그 날짜에 직접 칠한 값
2. 연동한 캘린더에 일정이 있으면 그 캘린더에 정한 색 (여러 개가 겹치면 더 나쁜 쪽)
3. 매주 기본 시간표
4. 아무것도 없으면 미입력(회색)

여러 사람을 비교할 때는 칸마다 **가장 낮은 단계**를 쓰고, 한 명이라도 미입력이면 회색으로 보여요.

### 개인정보

- 캘린더에서는 **바쁜 시간 구간만** 저장하고 일정 제목·장소·내용은 저장하지 않아요. (구글은 FreeBusy API만 사용)
- 친구에게는 칸별 단계만 보이고, 그 칸이 캘린더에서 왔는지 직접 칠했는지는 보이지 않아요.
- 친구로 수락된 사람만 내 시간표를 볼 수 있어요.

## 실행하기

Node.js **22.13 이상**이 필요해요. (내장 SQLite 사용, 별도 DB 설치 불필요)

```bash
cd eonjebom
npm install
cp .env.example .env   # 필요하면 값 수정
npm start              # http://localhost:3000
```

테스트:

```bash
npm test
```

### 구글 캘린더 연동 설정 (선택)

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 만들고 **Google Calendar API**를 사용 설정해요.
2. OAuth 동의 화면을 설정하고, 범위에 `calendar.freebusy`, `calendar.calendarlist.readonly`를 추가해요.
3. 사용자 인증 정보 → OAuth 클라이언트 ID(웹 애플리케이션)를 만들고, 승인된 리디렉션 URI에 `{BASE_URL}/api/google/callback`을 넣어요.
4. `.env`의 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BASE_URL`을 채우고 서버를 다시 시작해요.

설정하지 않아도 iCal 주소·파일 연동과 나머지 기능은 모두 동작해요.

### 삼성 캘린더 연동

삼성 캘린더는 웹에서 쓸 수 있는 공개 API가 없어요. 대신 아래 방법 중 하나를 쓰면 돼요.

- 삼성 캘린더 앱에서 일정을 **구글 계정 캘린더에 저장·동기화**한 뒤, 언제봄에서 구글 캘린더를 연결해요. (추천)
- 일정을 `.ics` 파일로 내보내 언제봄에 올려요.

## 구조

```
eonjebom/
├─ src/
│  ├─ server.js        # 진입점: 환경 변수, 주기 동기화(30분마다, 3시간 지난 캘린더)
│  ├─ app.js           # Express 앱과 REST API
│  ├─ db.js            # SQLite 스키마
│  ├─ auth.js          # 비밀번호(scrypt), 세션 쿠키, 로그인 시도 제한
│  ├─ availability.js  # 일정 합치기·비교·추천 (순수 함수)
│  ├─ time.js          # KST 날짜/30분 슬롯 계산
│  ├─ ics.js           # .ics 해석 (반복 일정, 예외, 시간대)
│  ├─ google.js        # 구글 OAuth + FreeBusy
│  ├─ calendars.js     # 캘린더 동기화
│  └─ safe-fetch.js    # iCal 주소 가져오기 (내부망 접근 차단, 5MB 제한)
├─ public/             # 빌드 없는 순수 HTML/CSS/JS 프론트엔드
└─ test/               # node:test 단위·API 테스트
```

## API 요약

모든 쓰기 요청은 `Content-Type: application/json` 이어야 해요.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/api/auth/signup` · `/api/auth/login` · `/api/auth/logout` | 계정 |
| GET | `/api/me` | 내 정보 |
| GET / PUT | `/api/weekly` | 기본 시간표 (`cells: [{weekday, slot, level\|null}]`) |
| PUT | `/api/overrides` | 날짜별 덮어쓰기 (`cells: [{date, slot, level\|null}]`) |
| GET | `/api/schedule?start=YYYY-MM-DD&days=7` | 내 실제 일정 |
| GET / POST | `/api/friends` | 친구 목록 / 요청 보내기 (`{username}`) |
| POST | `/api/friends/:id/accept` | 요청 수락 |
| DELETE | `/api/friends/:id` | 거절·취소·친구 삭제 |
| GET | `/api/compare?with=2,3&start=&days=7&minSlots=2&minLevel=3` | 비교 + 추천 |
| GET / POST | `/api/calendars` | 캘린더 목록 / 추가 (`ics_url`, `ics_file`) |
| PATCH / DELETE | `/api/calendars/:id` | 색 단계 변경 / 해제 |
| POST | `/api/calendars/:id/sync` | 지금 동기화 |
| GET | `/api/google/connect` → `/api/google/callback` | 구글 OAuth |

`slot`은 하루를 30분 단위로 나눈 번호(0 = 00:00, 47 = 23:30), `weekday`는 0 = 월요일, `level`은 1(안 됨) ~ 5(아주 좋음)이에요. 모든 시간은 한국 시간(KST) 기준이에요.

## 알려진 한계 / 다음 단계

- 종일 일정(생일 등)은 시간을 막지 않는 것으로 처리해요.
- 시간대는 KST로 고정이에요. 해외 친구와 쓰려면 사용자별 시간대 설정이 필요해요.
- 안드로이드 앱을 만들면 삼성 캘린더를 기기에서 직접 읽을 수 있어요.
- 운영 배포 시에는 HTTPS(`BASE_URL=https://…`)로 실행해야 쿠키에 `Secure`가 붙어요.
