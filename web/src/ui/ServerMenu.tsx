import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { loadServerCatalog, serverName, type CatalogServer } from '../core/catalog';
import { currentServerUrl } from '../core/servers';
import { locale } from '../i18n';
import { Button, Menu, MenuContent, MenuItem, MenuTrigger, type ButtonProps } from './kit';
import './server-menu.css';

/**
 * «Сменить сервер» в браузере (R136): серверы Cord из каталога этой установки, а выбор — просто
 * переход на сайт того сервера. Встречи, избранное и имя принадлежат серверу и с ним не переезжают;
 * там свой вход. Текущий сервер стоит в списке отмеченным, чтобы было видно, где вы сейчас.
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
  if (!servers.some((server) => server.url !== here)) return null;
  const language = locale(t);
  return (
    <Menu>
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
              onClick={() => location.assign(server.url)}
            >
              <span className="server-menu__name">{serverName(server, language)}</span>
              <span className="server-menu__host">
                {current ? t(($) => $.settings.server.here) : new URL(server.url).host}
              </span>
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}
