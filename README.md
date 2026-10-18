# scan-walk

LiDAR 방 스캔(USDZ, PLY, XYZ)을 브라우저에서 열어 1인칭으로 날아다니며 보는 뷰어.

## 개인정보

- 파일은 기기 밖으로 나가지 않는다. 서버도 계정도 없다.
- CSP `connect-src 'none'` 이 fetch·XHR·WebSocket·beacon 을 막는다. 라이브러리는 importmap SRI 해시로 고정돼 있다.
- 마지막으로 연 파일은 이 브라우저의 IndexedDB 에만 저장된다. 지우기: `잊기` 버튼, 또는 iPhone 설정 > Safari > 고급 > 웹사이트 데이터.
- 다시 열다가 탭이 죽으면 다음 실행 때 자동으로 열지 않고 `다시 열기`/`잊기` 를 묻는다.
- Safari 개인정보 보호 탭에서는 마지막 파일을 기억하지 못한다.

## 쓰는 법

**폰**

1. 3D Scanner App 에서 USDZ, PLY 또는 XYZ color 로 내보내 "파일에 저장"한다.
2. 이 페이지에서 `스캔 열기` 로 `.usdz`·`.ply`·`.xyz` 를 고른다.
3. 화면 왼쪽 절반: 이동 스틱. 앞뒤는 보는 방향, 옆은 수평. 최고 3m/s.
4. 화면 오른쪽 절반: 시점 스틱. 밀고 있는 동안 돈다. 최고 90°/s.
5. 스틱은 엄지를 댄 자리에 생기고, 놓으면 멈춘다. 벽·천장·바닥을 통과한다.

**PC**

- 파일을 창에 끌어다 놓는다.
- 클릭하면 마우스가 잠기고 마우스로 시점을 돌린다(Esc 로 해제, 잠기지 않으면 드래그).
- WASD·방향키: 보는 방향으로 이동. Space/E: 위로. Shift/Q: 아래로. C: 좌표.

**버튼**

| 버튼 | 하는 일 |
|---|---|
| 열기 | 다른 파일 열기 |
| 조명 | 장면 조명 켜기/끄기(메시만) |
| 축 | 위쪽 축 바꾸기(+Y, +Z, −Z, +X, −X, −Y) |
| ×1 | 배율 바꾸기(×1, ×0.01, ×100, ×0.1, ×10) |
| 처음 | 시작 위치로 |
| 좌표 | 카메라 x·y·z(m), pitch·yaw·roll(°) 보이기/숨기기 |
| 잊기 | 저장된 마지막 파일 지우기 |

시작 위치: 스캔의 가로 중심, 바닥 위 1.6m. 2m 미만 물체 스캔은 물체 밖에서 바라보며 시작한다.

## 개발

빌드 없음. 정적 서버로 띄운다.

```sh
python3 -m http.server
```

e2e(Playwright):

```sh
pip install usd-core pillow
python test/make_room.py /tmp/rooms
python3 -m http.server 8765 &
ASSETS=/tmp/rooms node test/e2e.mjs
```

환경변수는 `test/e2e.mjs` 첫머리. 합성 스캔 목록은 `test/make_room.py` 첫머리.
