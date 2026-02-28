import { useTranslation } from "react-i18next";
import { Field, Input, makeStyles } from "@fluentui/react-components";
import { SearchRegular } from "@fluentui/react-icons";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

const useStyles = makeStyles({
  root: {
    maxWidth: "480px",
    width: "100%",
    minWidth: 0,
  },
});

export function SearchBox({ value, onChange }: Props) {
  const styles = useStyles();
  const { t } = useTranslation();

  return (
    <div className={styles.root}>
      <Field label={t("search.label")}>
        <Input
          contentBefore={<SearchRegular />}
          placeholder={t("search.placeholder")}
          value={value}
          onChange={(_: unknown, data: { value: string }) => onChange(data.value)}
        />
      </Field>
    </div>
  );
}
