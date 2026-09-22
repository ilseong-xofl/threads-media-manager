import { useRef, useState, type PointerEvent } from 'react';
import { fitCrop, integerCrop, moveCrop, resizeCrop, type CropRect, type Size } from './crop-model';
import { Icon } from './Icon';

const ratios = [
  ['original', '원본'],
  ['free', '자유'],
  ['1', '1:1'],
  ['0.8', '4:5'],
  ['0.75', '3:4'],
  ['0.5625', '9:16'],
  ['1.3333333333333333', '4:3'],
  ['1.7777777777777777', '16:9'],
];
type Point = { x: number; y: number };
type Gesture = { point: Point; crop: CropRect } | { anchor: Point };

export function ImageCropEditor({
  src,
  saving,
  onSave,
  onCancel,
}: {
  src: string;
  saving: boolean;
  onSave(crop: CropRect): void;
  onCancel(): void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [ratioChoice, setRatioChoice] = useState('original');
  const [failed, setFailed] = useState(false);
  const ratio =
    ratioChoice === 'free'
      ? null
      : ratioChoice === 'original' && size
        ? size.width / size.height
        : Number(ratioChoice);
  const output = size && crop ? integerCrop(crop, size) : null;
  function point(event: PointerEvent<HTMLDivElement>): Point {
    const bounds = stage.current!.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * size!.width,
      y: ((event.clientY - bounds.top) / bounds.height) * size!.height,
    };
  }
  function start(event: PointerEvent<HTMLDivElement>) {
    if (!size || !crop || saving || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const cursor = point(event);
    const corner = (event.target as HTMLElement).dataset.corner;
    if (corner) {
      gesture.current = {
        anchor: {
          x: corner.includes('w') ? crop.x + crop.width : crop.x,
          y: corner.includes('n') ? crop.y + crop.height : crop.y,
        },
      };
    } else if (
      cursor.x >= crop.x &&
      cursor.x <= crop.x + crop.width &&
      cursor.y >= crop.y &&
      cursor.y <= crop.y + crop.height
    ) {
      gesture.current = { point: cursor, crop };
    } else {
      gesture.current = { anchor: cursor };
      setCrop(resizeCrop(cursor, cursor, size, ratio));
    }
  }
  return (
    <section className="image-editor" aria-label="이미지 크롭 편집">
      <div className="crop-toolbar">
        <label htmlFor="crop-ratio">비율</label>
        <div className="select-field">
          <select
            id="crop-ratio"
            value={ratioChoice}
            disabled={saving || !size}
            onChange={(event) => {
              const choice = event.target.value;
              setRatioChoice(choice);
              if (size)
                setCrop(
                  fitCrop(
                    size,
                    choice === 'free'
                      ? null
                      : choice === 'original'
                        ? size.width / size.height
                        : Number(choice),
                  ),
                );
            }}
          >
            {ratios.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <Icon name="chevron" />
        </div>
        <button
          type="button"
          disabled={saving || !size}
          onClick={() => {
            if (size) setCrop(fitCrop(size, ratio));
          }}
        >
          초기화
        </button>
        {output && (
          <span className="crop-dimensions">
            {output.width} × {output.height}
          </span>
        )}
      </div>
      <div className="crop-viewport">
        <div
          ref={stage}
          className="crop-canvas"
          tabIndex={0}
          role="group"
          aria-label="크롭 영역. 드래그로 조절하거나 방향키로 이동하세요."
          style={
            size
              ? {
                  aspectRatio: `${size.width} / ${size.height}`,
                  maxWidth: `min(100%, ${(size.width / size.height) * 440}px, calc(${(size.width / size.height) * 100}vh - ${(size.width / size.height) * 350}px))`,
                }
              : undefined
          }
          onPointerDown={start}
          onPointerMove={(event) => {
            if (!gesture.current || !size || saving) return;
            const cursor = point(event);
            const active = gesture.current;
            setCrop(
              'anchor' in active
                ? resizeCrop(active.anchor, cursor, size, ratio)
                : moveCrop(active.crop, cursor.x - active.point.x, cursor.y - active.point.y, size),
            );
          }}
          onPointerUp={() => {
            gesture.current = null;
          }}
          onPointerCancel={() => {
            gesture.current = null;
          }}
          onLostPointerCapture={() => {
            gesture.current = null;
          }}
          onKeyDown={(event) => {
            if (!crop || !size || saving) return;
            const step = event.shiftKey ? 10 : 1;
            const direction = {
              ArrowLeft: [-step, 0],
              ArrowRight: [step, 0],
              ArrowUp: [0, -step],
              ArrowDown: [0, step],
            }[event.key];
            if (direction) {
              event.preventDefault();
              event.stopPropagation();
              setCrop(moveCrop(crop, direction[0], direction[1], size));
            }
          }}
        >
          <img
            src={src}
            alt="크롭할 원본 이미지"
            draggable={false}
            onError={() => setFailed(true)}
            onLoad={(event) => {
              const image = event.currentTarget;
              const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
              if (!dimensions.width || !dimensions.height) {
                setFailed(true);
                return;
              }
              setSize(dimensions);
              setCrop(fitCrop(dimensions, dimensions.width / dimensions.height));
            }}
          />
          {size && crop && !failed && (
            <div
              className="crop-selection"
              style={{
                left: `${(crop.x / size.width) * 100}%`,
                top: `${(crop.y / size.height) * 100}%`,
                width: `${(crop.width / size.width) * 100}%`,
                height: `${(crop.height / size.height) * 100}%`,
              }}
            >
              <span className="crop-thirds" />
              {['nw', 'ne', 'sw', 'se'].map((corner) => (
                <span key={corner} className={`crop-handle ${corner}`} data-corner={corner} />
              ))}
            </div>
          )}
        </div>
      </div>
      {failed ? (
        <p className="editor-error" role="alert">
          이미지를 열 수 없습니다. 편집을 닫고 파일 상태를 확인하세요.
        </p>
      ) : (
        <p className="crop-help">
          모서리를 드래그해 크기를 조절하고, 영역 안을 드래그해 이동하세요.
        </p>
      )}
      <div className="media-editor-footer">
        <button type="button" disabled={saving} onClick={onCancel}>
          취소
        </button>
        <button
          type="button"
          className="primary"
          disabled={saving || !output || failed}
          onClick={() => {
            if (output) onSave(output);
          }}
        >
          {saving ? '저장 중…' : '편집본 저장'}
        </button>
      </div>
    </section>
  );
}
