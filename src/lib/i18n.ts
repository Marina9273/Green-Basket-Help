import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import enHelp from '@/locales/en/help.json';
import ruHelp from '@/locales/ru/help.json';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { help: enHelp, common: { validation: { requiredField: 'This field is required.' } } },
      ru: { help: ruHelp, common: { validation: { requiredField: 'Заполните обязательное поле.' } } },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'ru'],
    defaultNS: 'help',
    ns: ['help', 'common'],
    detection: { order: ['localStorage', 'navigator', 'htmlTag'], caches: ['localStorage'] },
    interpolation: { escapeValue: false },
  });

export default i18n;
