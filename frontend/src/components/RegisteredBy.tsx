import { useAuth } from '../context/AuthContext';

/**
 * "Registrado por" — quién cargó una fila, cuando NO fuiste vos.
 *
 * El dato ya existía (`user_id` guarda al AUTOR del registro, no al dueño del
 * campo) y las tablas de escritorio lo mostraban en una columna oculta en
 * mobile. Las tarjetas de mobile declaraban `user_name` en su tipo y no lo
 * pintaban: en el teléfono, que es por donde se usa el bot, no había forma de
 * saber quién había cargado qué en un campo compartido.
 *
 * Se muestra solo si el autor es OTRO usuario. En un campo propio todas las
 * filas son tuyas y repetir tu nombre en cada tarjeta es ruido puro; en uno
 * compartido, lo único que agrega información es lo que cargó el otro.
 */
export default function RegisteredBy({
  userId,
  userName,
  editedByName,
  className = '',
}: {
  /** Autor de la fila (`user_id`). */
  userId?: number | null;
  userName?: string | null;
  editedByName?: string | null;
  className?: string;
}) {
  const { user } = useAuth();

  const isSomeoneElse = userId != null && user != null && Number(userId) !== Number(user.id);
  if (!isSomeoneElse) return null;
  if (!userName && !editedByName) return null;

  const label = userName ?? 'otro usuario';
  return (
    <span className={`truncate ${className}`} title={`Registrado por ${label}`}>
      por {label}
      {editedByName && editedByName !== userName ? ` · editado por ${editedByName}` : ''}
    </span>
  );
}
