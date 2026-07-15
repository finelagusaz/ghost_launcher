import { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Input, makeStyles } from "@fluentui/react-components";
import { DismissRegular, SearchRegular } from "@fluentui/react-icons";

interface Props {
  value: string;
  onChange: (value: string) => void;
  // 一覧の選択移動・起動を親へ通知する。IME 変換中は発火しない
  onArrowDown?: () => void;
  onArrowUp?: () => void;
  onEnter?: () => void;
}

const useStyles = makeStyles({
  root: {
    width: "100%",
    minWidth: 0,
  },
});

export function SearchBox({ value, onChange, onArrowDown, onArrowUp, onEnter }: Props) {
  const styles = useStyles();
  const { t } = useTranslation();
  // IME 変換中は props.onChange（検索クエリ更新）をブロックするフラグ
  const isComposing = useRef(false);
  // 表示値はローカル管理。IME 変換中も読み仮名が崩れないよう常に更新する
  const [inputValue, setInputValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // 外部から value が変化したとき（検索クリアなど）に追従する
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  // 起動直後に検索欄へフォーカスし、打鍵をそのまま検索へ流せるようにする（launcher の要）
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const clearQuery = () => {
    // IME フラグをリセットしてから空にする（onCompositionEnd による打ち消し防止）
    isComposing.current = false;
    setInputValue("");
    onChange("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // IME 変換中のキー（Esc=変換取消 / Enter=確定 / ↑↓=候補移動）は検索操作に流用しない
    if (e.nativeEvent.isComposing || isComposing.current) return;
    switch (e.key) {
      case "Escape":
        if (inputValue) {
          clearQuery();
          e.preventDefault();
        }
        break;
      case "ArrowDown":
        onArrowDown?.();
        e.preventDefault();
        break;
      case "ArrowUp":
        onArrowUp?.();
        e.preventDefault();
        break;
      case "Enter":
        onEnter?.();
        break;
    }
  };

  return (
    <div className={styles.root} data-testid="search-input">
      <Field label={t("search.label")}>
        <Input
          ref={inputRef}
          contentBefore={<SearchRegular />}
          contentAfter={
            inputValue ? (
              <Button
                appearance="transparent"
                size="small"
                icon={<DismissRegular />}
                aria-label={t("search.clear")}
                onClick={clearQuery}
                data-testid="search-clear-button"
              />
            ) : undefined
          }
          placeholder={t("search.placeholder")}
          value={inputValue}
          onKeyDown={handleKeyDown}
          onChange={(_: unknown, data: { value: string }) => {
            setInputValue(data.value);
            if (!isComposing.current) onChange(data.value);
          }}
          onCompositionStart={() => { isComposing.current = true; }}
          onCompositionEnd={(e) => {
            isComposing.current = false;
            onChange(e.currentTarget.value);
          }}
        />
      </Field>
    </div>
  );
}
