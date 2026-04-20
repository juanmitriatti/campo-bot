import { useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polygon } from 'react-leaflet';
import type { LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useMapData } from '../../hooks/useMapData';

// Fix default marker icons in leaflet + webpack/vite
import L from 'leaflet';
// @ts-ignore
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

const STATUS_COLORS: Record<string, string> = {
  active: '#22c55e',
  harvested: '#eab308',
  idle: '#9ca3af',
};

export default function FieldMap() {
  const { data, loading } = useMapData();
  const [collapsed, setCollapsed] = useState(false);

  if (loading) return null;
  if (!data || data.fields.length === 0) return null;

  // Find fields with coordinates
  const fieldsWithCoords = data.fields.filter(f => f.lat && f.lng);
  if (fieldsWithCoords.length === 0 && !data.fields.some(f => f.polygon)) return null;

  // Calculate center
  let center: LatLngExpression = [-34, -64]; // Argentina default
  if (fieldsWithCoords.length > 0) {
    const avgLat = fieldsWithCoords.reduce((s, f) => s + f.lat!, 0) / fieldsWithCoords.length;
    const avgLng = fieldsWithCoords.reduce((s, f) => s + f.lng!, 0) / fieldsWithCoords.length;
    center = [avgLat, avgLng];
  }

  // Group plots by field
  const plotsByField = new Map<number, typeof data.plots>();
  for (const plot of data.plots) {
    const list = plotsByField.get(plot.fieldId) || [];
    list.push(plot);
    plotsByField.set(plot.fieldId, list);
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors"
      >
        <h3 className="text-sm font-semibold text-gray-700">Mis campos</h3>
        <span className="text-gray-400 text-xs">{collapsed ? 'Mostrar' : 'Ocultar'}</span>
      </button>
      {!collapsed && (
        <div style={{ height: window.innerWidth < 768 ? 300 : 400 }}>
          <MapContainer center={center} zoom={8} style={{ height: '100%', width: '100%' }}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {fieldsWithCoords.map(field => {
              const fieldPlots = plotsByField.get(field.id) || [];
              return (
                <Marker key={field.id} position={[field.lat!, field.lng!]}>
                  <Popup>
                    <div className="text-sm">
                      <strong>{field.name}</strong>
                      {field.city && <p className="text-gray-500">{field.city}</p>}
                      {fieldPlots.length > 0 && (
                        <ul className="mt-1">
                          {fieldPlots.map(p => (
                            <li key={p.id}>
                              <span style={{ color: STATUS_COLORS[p.cropStatus] }}>&#x25CF;</span>{' '}
                              {p.name}
                              {p.activeCrop && ` (${p.activeCrop})`}
                              {p.areaHectares && ` — ${p.areaHectares} ha`}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </Popup>
                </Marker>
              );
            })}
            {data.fields
              .filter(f => f.polygon && Array.isArray(f.polygon))
              .map(field => {
                const fieldPlots = plotsByField.get(field.id) || [];
                const mainStatus = fieldPlots.length > 0
                  ? (fieldPlots.some(p => p.cropStatus === 'active') ? 'active'
                     : fieldPlots.some(p => p.cropStatus === 'harvested') ? 'harvested' : 'idle')
                  : 'idle';
                const positions: LatLngExpression[] = field.polygon.map((p: any) => [p.lat, p.lng]);
                return (
                  <Polygon
                    key={`poly-${field.id}`}
                    positions={positions}
                    pathOptions={{ color: STATUS_COLORS[mainStatus], fillOpacity: 0.2 }}
                  >
                    <Popup>
                      <div className="text-sm">
                        <strong>{field.name}</strong>
                        {fieldPlots.map(p => (
                          <p key={p.id}>
                            {p.name}{p.activeCrop ? ` — ${p.activeCrop}` : ''}
                          </p>
                        ))}
                      </div>
                    </Popup>
                  </Polygon>
                );
              })}
          </MapContainer>
        </div>
      )}
    </div>
  );
}
