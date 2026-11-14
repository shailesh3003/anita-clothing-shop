import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { Languages } from 'lucide-react'
import { translate } from './translations.js'

const LanguageContext = createContext(null)
const storageKey = 'anita.language'

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(() => {
    try { return window.localStorage.getItem(storageKey) === 'mr' ? 'mr' : 'en' }
    catch { return 'en' }
  })
  useEffect(() => {
    document.documentElement.lang = language
    document.title = translate('Anita Clothing Shop', language)
    try { window.localStorage.setItem(storageKey, language) } catch { /* Language switching still works when storage is unavailable. */ }
  }, [language])
  const t = useCallback((text, values) => translate(text, language, values), [language])
  return <LanguageContext.Provider value={{ language, setLanguage, t, locale: language === 'mr' ? 'mr-IN' : 'en-IN' }}>{children}</LanguageContext.Provider>
}

export function useLanguage() { return useContext(LanguageContext) }

export function LanguageSelector() {
  const { language, setLanguage, t } = useLanguage()
  return <label className="language-selector">
    <span><Languages size={17} aria-hidden="true" />{t('Language')}</span>
    <select aria-label="Language / भाषा" value={language} onChange={event => setLanguage(event.target.value)}>
      <option value="en" lang="en">English</option>
      <option value="mr" lang="mr">मराठी</option>
    </select>
  </label>
}
