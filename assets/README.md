# 앱 아이콘

검은 배경의 흰색 Threads 형태 심볼과 하늘색 `ILS` 배지를 사용한다. 사용자가 지정한 배지 위치와 크기를 유지하고, 심볼을 위로 올려 배지와 겹치는 부분에서 배지가 앞에 보이도록 했다. 최종 시안을 사용자 확인 후 적용했다.
내장 ImageGen의 참조 이미지 편집 모드로 생성했다.

- `app-icon.png`: 투명 배경 원본. 운영용(`prod`)이 쓴다.
- `app-icon.ico`: Windows 실행 파일·창·Setup용. 16, 20, 24, 32, 40, 48, 64, 128, 256px 프레임을 포함한다.
- `app-icon-dev.png`, `app-icon-dev.ico`: 개발용(`dev`). 배지의 하늘색만 주황(`#D9822B`)으로 바꾼 것이고 크기와 ICO 프레임 구성은 같다. 포장하지 않은 실행(Mac 개발 Dock과 앱 창)도 이 파일을 쓴다.
- 벌마다 쓰는 파일은 `variants.json`의 `icon`이 정한다. Forge가 그 벌의 PNG와 ICO만 패키지의 `resources`에 복사한다. 개발 실행은 앱 루트의 `assets`에서 읽는다.
- Windows 제어판의 프로그램 아이콘은 해당 버전 태그의 공개 ICO 주소를 사용한다. Windows CI는 패키지 안의 PNG·ICO가 그 벌의 원본과 동일한지 SHA-256으로 확인한다.

PNG 교체 후 기존 Pillow 환경으로 ICO를 다시 만든다.

```python
from PIL import Image

image = Image.open('assets/app-icon.png')
image.save(
    'assets/app-icon.ico',
    format='ICO',
    sizes=[(size, size) for size in (16, 20, 24, 32, 40, 48, 64, 128, 256)],
)
```

## 개발용 아이콘 만들기

`app-icon.png`를 바꾸면 개발용도 다시 만든다. 배지 둘레(x 156–548, y 173–372)의 픽셀을 하늘색·흰색·검정의 섞임으로 보고 하늘색 몫만 주황으로 바꾼다. 그래서 글자와 가장자리의 부드러운 경계가 그대로 남고, 그 범위 밖은 원본과 한 픽셀도 다르지 않다. 배지 위치나 색이 바뀌면 범위와 `BLUE`를 새로 잰다.

```python
from PIL import Image

BLUE, ORANGE = (46, 168, 234), (217, 130, 43)  # badge colour in app-icon.png, dev colour
image = Image.open('assets/app-icon.png').convert('RGBA')
pixels = image.load()
bb, bw = sum(c * c for c in BLUE), sum(BLUE)
for y in range(173, 373):
    for x in range(156, 549):
        r, g, b, a = pixels[x, y]
        # Least-squares share of badge blue in a mix of blue and white (black adds nothing).
        blue = max(0, 3 * (r * BLUE[0] + g * BLUE[1] + b * BLUE[2]) - (r + g + b) * bw) / (3 * bb - bw * bw)
        pixels[x, y] = (
            *(min(255, max(0, round(v + blue * (o - c)))) for v, c, o in zip((r, g, b), BLUE, ORANGE)),
            a,
        )
image.save('assets/app-icon-dev.png')
image.save(
    'assets/app-icon-dev.ico',
    format='ICO',
    sizes=[(size, size) for size in (16, 20, 24, 32, 40, 48, 64, 128, 256)],
)
```

## 최종 이미지 편집 프롬프트

Edit this exact supplied 1254 x 1254 app icon with ONE geometrical change only: translate the WHITE THREADS GLYPH straight UP by 50 pixels. Its current visible bounds are approximately x=316..939, y=337..1020; its new intended bounds are x=316..939, y=287..970, so its center coincides with the BLACK TILE center at approximately (627,630). Do not scale, reshape, rotate or horizontally move the white glyph. The SKY BLUE ILS BADGE IS LOCKED: keep its exact existing position x=159..544, y=176..370, its exact size, rounded shape, lettering and color. The black rounded square is locked and unchanged. Preserve the white symbol's continuous shape behind the badge; where the newly raised white symbol intersects the badge's bottom-right region, the sky-blue ILS badge must visibly cover the white stroke because the badge is the TOP foreground layer. No gap, no pushing the symbol down to avoid the badge, no moving the badge to make overlap happen. Only move the white Threads glyph up 50 pixels behind the fixed badge. Preserve the exact existing flat frontal icon styling, black tile, transparent outer margin, dimensions, and all other features.
