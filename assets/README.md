# 앱 아이콘

검은 배경의 흰색 Threads 형태 심볼과 하늘색 `ILS` 배지를 사용한다. 사용자가 지정한 배지 위치와 크기를 유지하고, 심볼을 위로 올려 배지와 겹치는 부분에서 배지가 앞에 보이도록 했다. 최종 시안을 사용자 확인 후 적용했다.
내장 ImageGen의 참조 이미지 편집 모드로 생성했다.

- `app-icon.png`: 투명 배경 원본. Mac 개발 Dock과 앱 창에서 사용한다.
- `app-icon.ico`: Windows 실행 파일·창·Setup용. 16, 20, 24, 32, 40, 48, 64, 128, 256px 프레임을 포함한다.
- Forge가 PNG와 ICO를 패키지의 `resources`에 복사한다. 개발 실행은 앱 루트의 `assets`에서 읽는다.
- Windows 제어판의 프로그램 아이콘은 해당 버전 태그의 공개 ICO 주소를 사용한다. Windows CI는 패키지 안의 PNG·ICO가 원본과 동일한지 SHA-256으로 확인한다.

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

## 최종 이미지 편집 프롬프트

Edit this exact supplied 1254 x 1254 app icon with ONE geometrical change only: translate the WHITE THREADS GLYPH straight UP by 50 pixels. Its current visible bounds are approximately x=316..939, y=337..1020; its new intended bounds are x=316..939, y=287..970, so its center coincides with the BLACK TILE center at approximately (627,630). Do not scale, reshape, rotate or horizontally move the white glyph. The SKY BLUE ILS BADGE IS LOCKED: keep its exact existing position x=159..544, y=176..370, its exact size, rounded shape, lettering and color. The black rounded square is locked and unchanged. Preserve the white symbol's continuous shape behind the badge; where the newly raised white symbol intersects the badge's bottom-right region, the sky-blue ILS badge must visibly cover the white stroke because the badge is the TOP foreground layer. No gap, no pushing the symbol down to avoid the badge, no moving the badge to make overlap happen. Only move the white Threads glyph up 50 pixels behind the fixed badge. Preserve the exact existing flat frontal icon styling, black tile, transparent outer margin, dimensions, and all other features.
