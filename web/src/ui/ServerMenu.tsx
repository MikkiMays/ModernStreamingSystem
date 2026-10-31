import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { loadServerCatalog, serverName, type CatalogServer } from '../core/catalog';
import { currentServerUrl } from '../core/servers';
import { useCatalogLoad } from '../core/server-load';
import { goToServer } from '../core/shared-preferences';
import { locale } from '../i18n';
import { Button, LoadBars, Menu, MenuContent, MenuItem, MenuTrigger, type ButtonProps } from './kit';
import './server-menu.css';

/**
 * «Сменить сервер» в браузере (R136): серверы Cord из каталога этой установки, а выбор — просто
 * переход на сайт того сервера. Настройки общие (R146): несекретные едут с переходом во фрагменте
 * адреса (`goToServer`, `core/shared-preferences.ts`); встречи, избранное и недавние у каждого
 * сервера свои, и вход там свой. Текущий сервер стоит в списке отмеченным, чтобы было видно, где вы
 * сейчас.
 *
 * Каталога нет или в нём только этот сервер — кнопки нет: выбирать не из чего. В приложении для
 * Windows эта кнопка не нужна — у него свой список серверов (`servers.open`).
 */
export function ServerMenu({
  label,
  icon,
  variant = 'secondary',
  size = 'sm',
  disabled,
  title,
  align = 'end',
}: {
  label: string;
  icon?: ReactNode;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  disabled?: boolean;
  title?: string;
  align?: 'start' | 'end';
}) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<CatalogServer[]>([]);
  useEffect(() => {
    let active = true;
    void loadServerCatalog().then((found) => {
      if (active) setServers(found);
    });
    return () => {
      active = false;
    };
  }, []);
  const here = currentServerUrl();
  const [open, setOpen] = useState(false);
  const loads = useCatalogLoad(open);
  if (!servers.some((server) => server.url !== here)) return null;
  const language = locale(t);
  return (
    <Menu onOpenChange={setOpen}>
      <MenuTrigger
        disabled={disabled}
        render={
          <Button size={size} variant={variant} icon={icon} disabled={disabled} title={title}>
            {label}
          </Button>
        }
      />
      <MenuContent align={align}>
        {servers.map((server) => {
          const current = server.url === here;
          return (
            <MenuItem
              key={server.url}
              icon={current ? <Check /> : null}
              disabled={current}
              className="server-menu__item"
              onClick={() => goToServer(server.url)}
            >
              <span className="server-menu__name">{serverName(server, language)}</span>
              <span className="server-menu__host">
                {current ? t(($) => $.settings.server.here) : new URL(server.url).host}
              </span>
              {/* Загрузка (R143): ступени соседей спрашивает ядро — CSP не пускает браузер к ним. */}
              <LoadBars
                className="server-menu__load"
                level={loads?.get(new URL(server.url).origin)?.level}
                state={loads?.get(new URL(server.url).origin)?.state}
              />
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}
