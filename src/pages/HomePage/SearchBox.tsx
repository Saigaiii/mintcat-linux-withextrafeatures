import React from "react";
import {Select, SelectProps} from "antd";
import {SearchOutlined} from "@ant-design/icons";
import {useTranslation} from "react-i18next";
import {TreeViewConverter} from "@/pages/HomePage/TreeViewConverter.ts";

type FilterOptionGroup = NonNullable<SelectProps["options"]>;

const defaultFilterOptionDefinitions = [
    {
        labelKey: "Source",
        options: [
            {value: "source:Local", labelKey: "Local"},
            {value: "source:Modio", labelKey: "Modio"},
            {value: "source:modcat", labelKey: "ModCat"},
        ],
    },
    {
        labelKey: "Enabled",
        options: [
            {value: "enabled:true", labelKey: "Enable"},
            {value: "enabled:false", labelKey: "Disable"},
        ],
    },
    {
        labelKey: "Status",
        options: [
            {value: "Verified", labelKey: "Verified"},
            {value: "Approved", labelKey: "Approved"},
            {value: "Sandbox", labelKey: "Sandbox"},
        ],
    },
    {
        labelKey: "Tags",
        options: [
            {value: "RequiredByAll", labelKey: "RequiredByAll"},
            {value: "Optional", labelKey: "Optional"},
            {value: "Audio", labelKey: "Audio"},
            {value: "Framework", labelKey: "Framework"},
            {value: "Tools", labelKey: "Tools"},
            {value: "QoL", labelKey: "QoL"},
            {value: "Visual", labelKey: "Visual"},
            {value: "Gameplay", labelKey: "Gameplay"},
        ],
    },
] as const;

const filterValueLabelKeyMap = defaultFilterOptionDefinitions.reduce<Record<string, string>>(
    (map, group) => {
        group.options.forEach((option) => {
            map[option.value] = option.labelKey;
        });
        return map;
    },
    {All: "All"},
);

interface SearchBoxProps {
    onUpdateTreeView: () => void;
}

function getFilterLabel(value: string, t: (key: string) => unknown): string {
    const labelKey = filterValueLabelKeyMap[value];
    return labelKey ? String(t(labelKey)) : value;
}

function buildDefaultFilterOptions(t: (key: string) => unknown): FilterOptionGroup {
    return defaultFilterOptionDefinitions.map((group) => ({
        label: String(t(group.labelKey)),
        options: group.options.map((option) => ({
            value: option.value,
            label: String(t(option.labelKey)),
        })),
    }));
}

/** 从 filterList 中收集不在默认选项里的自定义项，用于构建 options */
function getCustomOptionsFromFilterList(
    filterList: string[] | undefined,
    t: (key: string) => unknown,
): FilterOptionGroup {
    if (!filterList?.length) return [];

    const defaultValues = new Set<string>();
    defaultFilterOptionDefinitions.forEach((group) => {
        group.options.forEach((option) => defaultValues.add(option.value));
    });

    return filterList
        .filter((value) => !defaultValues.has(value))
        .map((value) => ({value, label: getFilterLabel(value, t)}));
}

export const SearchBox = ({ onUpdateTreeView }: SearchBoxProps) => {
    const { t } = useTranslation();
    const [searchKeyword, setSearchKeyword] = React.useState("");
    const [searchValue, setSearchValue] = React.useState<string[] | undefined>(() => {
        const list = TreeViewConverter.filterList;
        return list?.length ? list : undefined;
    });

    const defaultFilterOptions = React.useMemo<FilterOptionGroup>(() => {
        return buildDefaultFilterOptions(t);
    }, [t]);

    const searchOptions = React.useMemo<FilterOptionGroup>(() => {
        const filterList = Array.from(new Set([
            ...(searchValue ?? []),
            ...(searchKeyword ? [searchKeyword] : []),
        ]));
        const customOptions = getCustomOptionsFromFilterList(filterList, t);
        return customOptions.length ? [...customOptions, ...defaultFilterOptions] : defaultFilterOptions;
    }, [defaultFilterOptions, searchKeyword, searchValue, t]);

    // Typing filters as you go (shortly after the last key), together with the chips already picked
    const typingTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    React.useEffect(() => () => clearTimeout(typingTimer.current), []);

    const onSearch = (newValue: string) => {
        setSearchKeyword(newValue);
        const keyword = newValue.trim();
        TreeViewConverter.filterList = [...(searchValue ?? []), ...(keyword ? [keyword] : [])];
        clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => onUpdateTreeView(), 200);
    }

    const onSearchSelectChange = (picked: string[]) => {
        // Picking a filter clears the typed text; keep it as a filter of its own, unless it was
        // typed to find that choice (e.g. "mod" → mod.io)
        let value = picked;
        const keyword = searchKeyword.trim();
        if (keyword && !value.includes(keyword)) {
            const added = value.filter(v => !(searchValue ?? []).includes(v));
            const lower = keyword.toLocaleLowerCase();
            const typedForChoice = added.some(v =>
                v.toLocaleLowerCase().includes(lower) || getFilterLabel(v, t).toLocaleLowerCase().includes(lower));
            if (added.length > 0 && !typedForChoice) {
                value = [keyword, ...value];
            }
        }
        const nextValue = value.length ? value : undefined;
        clearTimeout(typingTimer.current);
        TreeViewConverter.filterList = nextValue ?? [];
        setSearchKeyword("");
        setSearchValue(nextValue);
        onUpdateTreeView();
    }

    // Esc clears the typed text in the box; drop its filter too so the list matches what's shown
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "Escape" || !searchKeyword) return;
        clearTimeout(typingTimer.current);
        setSearchKeyword("");
        TreeViewConverter.filterList = [...(searchValue ?? [])];
        onUpdateTreeView();
    }

    const onBlur = () => {
        const filterList = TreeViewConverter.filterList;
        setSearchKeyword("");
        setSearchValue(filterList?.length ? filterList : undefined);
    }

    return (
        <Select size={"small"}
                value={searchValue}
                options={searchOptions}
                onChange={onSearchSelectChange}
                onBlur={onBlur}
                onKeyDown={onKeyDown}
                className="w-300"
                placeholder={t("modSearch.placeholder")}
                suffixIcon={<SearchOutlined/>}
                notFoundContent={null}
                defaultActiveFirstOption={false}
                showSearch={{ onSearch, filterOption: false }}
                allowClear={true}
                mode={"multiple"}
        />
    )
}
