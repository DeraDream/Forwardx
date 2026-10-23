import { SizeEnum } from "./enums/SizeEnum";
import { LayoutEnum } from "./enums/LayoutEnum";
import { ThemeEnum } from "./enums/ThemeEnum";
import { LanguageEnum } from "./enums/LanguageEnum";

const { pkg } = __APP_INFO__;

const defaultSettings: AppSettings = {
  title: pkg.name,
  version: pkg.version,
  showSettings: false,
  tagsView: false,
  fixedHeader: true,
  sidebarLogo: true,
  layout: LayoutEnum.LEFT,
  theme: ThemeEnum.LIGHT,
  size: SizeEnum.DEFAULT,
  language: LanguageEnum.ZH_CN,
  themeColor: "#2563EB",
  watermarkEnabled: false,
  watermarkContent: pkg.name,
};

export default defaultSettings;
