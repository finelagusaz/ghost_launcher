import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchBox } from "./SearchBox";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("SearchBox", () => {
  it("マウント時に検索欄へオートフォーカスする", () => {
    render(<SearchBox value="" onChange={vi.fn()} />);
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("Esc で検索をクリアする（onChange('')）", () => {
    const onChange = vi.fn();
    render(<SearchBox value="れいむ" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("IME 変換中の Esc はクリアしない（変換取消と競合させない）", () => {
    const onChange = vi.fn();
    render(<SearchBox value="れいむ" onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalledWith("");
  });

  it("× ボタンで検索をクリアする", () => {
    const onChange = vi.fn();
    render(<SearchBox value="れいむ" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("search-clear-button"));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("入力が空のときは × ボタンを表示しない", () => {
    render(<SearchBox value="" onChange={vi.fn()} />);
    expect(screen.queryByTestId("search-clear-button")).not.toBeInTheDocument();
  });

  it("↑/↓/Enter で対応するコールバックを呼ぶ", () => {
    const onArrowDown = vi.fn();
    const onArrowUp = vi.fn();
    const onEnter = vi.fn();
    render(
      <SearchBox
        value=""
        onChange={vi.fn()}
        onArrowDown={onArrowDown}
        onArrowUp={onArrowUp}
        onEnter={onEnter}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onArrowDown).toHaveBeenCalledTimes(1);
    expect(onArrowUp).toHaveBeenCalledTimes(1);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("IME 変換中の ↑/↓/Enter はコールバックを呼ばない", () => {
    const onArrowDown = vi.fn();
    const onEnter = vi.fn();
    render(
      <SearchBox value="" onChange={vi.fn()} onArrowDown={onArrowDown} onEnter={onEnter} />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onArrowDown).not.toHaveBeenCalled();
    expect(onEnter).not.toHaveBeenCalled();
  });
});
