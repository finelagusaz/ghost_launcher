import { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Field, Input, makeStyles } from "@fluentui/react-components";
import { SearchRegular } from "@fluentui/react-icons";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

const useStyles = makeStyles({
  root: {
    width: "100%",
    minWidth: 0,
  },
});

export function SearchBox({ value, onChange }: Props) {
  const styles = useStyles();
  const { t } = useTranslation();
  // IME 変換中は props.onChange（検索クエリ更新）をブロックするフラグ
  const isComposing = useRef(false);
  // 表示値はローカル管理。IME 変換中も読み仮名が崩れないよう常に更新する
  const [inputValue, setInputValue] = useState(value);

  // 外部から value が変化したとき（検索クリアなど）に追従する
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  return (
    <div className={styles.root} data-testid="search-input">
      <Field label={t("search.label")}>
        <Input
          contentBefore={<SearchRegular />}
          placeholder={t("search.placeholder")}
          value={inputValue}
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
