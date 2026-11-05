import { Localized } from '../model/shared.schema'

/**
 * The common list for an empty vehicles-for-sale catalogue: types, specs and
 * accessories, in the seven languages (machine-made; the office edits them).
 * Added by `POST /admin/v1/vehicle-sales/catalogue/starter` and the local seed,
 * only where the slug or key is missing.
 */

const t = (fr: string, en: string, pt: string, es: string, zh: string, ar: string, ru: string): Localized => ({
   fr,
   en,
   pt,
   es,
   zh,
   ar,
   ru,
})

export const STARTER_TYPES: { slug: string; name: Localized }[] = [
   { slug: 'berline', name: t('Berline', 'Sedan', 'Sedã', 'Sedán', '轿车', 'سيدان', 'Седан') },
   { slug: 'suv', name: t('SUV', 'SUV', 'SUV', 'SUV', 'SUV', 'سيارة دفع رباعي', 'Внедорожник') },
   { slug: 'pick-up', name: t('Pick-up', 'Pickup', 'Picape', 'Pickup', '皮卡', 'بيك أب', 'Пикап') },
   { slug: 'citadine', name: t('Citadine', 'Hatchback', 'Hatchback', 'Compacto', '两厢车', 'هاتشباك', 'Хэтчбек') },
   { slug: 'break', name: t('Break', 'Wagon', 'Perua', 'Familiar', '旅行车', 'ستيشن واغن', 'Универсал') },
   { slug: 'monospace', name: t('Monospace', 'Minivan', 'Monovolume', 'Monovolumen', '多功能车', 'ميني فان', 'Минивэн') },
   { slug: 'minibus', name: t('Minibus', 'Minibus', 'Micro-ônibus', 'Microbús', '小型巴士', 'حافلة صغيرة', 'Микроавтобус') },
   { slug: 'bus', name: t('Bus', 'Bus', 'Ônibus', 'Autobús', '巴士', 'حافلة', 'Автобус') },
   { slug: 'camion', name: t('Camion', 'Truck', 'Caminhão', 'Camión', '卡车', 'شاحنة', 'Грузовик') },
   { slug: 'coupe', name: t('Coupé', 'Coupe', 'Cupê', 'Cupé', '轿跑车', 'كوبيه', 'Купе') },
   { slug: 'moto', name: t('Moto', 'Motorcycle', 'Moto', 'Moto', '摩托车', 'دراجة نارية', 'Мотоцикл') },
]

type StarterSpec = {
   key: string
   name: Localized
   valueType: 'CHOICE' | 'NUMBER'
   unit?: string
   choices?: { key: string; label: Localized }[]
   onCard?: boolean
}

export const STARTER_SPECS: StarterSpec[] = [
   {
      key: 'boite',
      name: t('Boîte de vitesses', 'Gearbox', 'Câmbio', 'Caja de cambios', '变速箱', 'ناقل الحركة', 'Коробка передач'),
      valueType: 'CHOICE',
      onCard: true,
      choices: [
         { key: 'automatique', label: t('Automatique', 'Automatic', 'Automático', 'Automática', '自动', 'أوتوماتيك', 'Автомат') },
         { key: 'manuelle', label: t('Manuelle', 'Manual', 'Manual', 'Manual', '手动', 'يدوي', 'Механика') },
      ],
   },
   {
      key: 'carburant',
      name: t('Carburant', 'Fuel', 'Combustível', 'Combustible', '燃料', 'الوقود', 'Топливо'),
      valueType: 'CHOICE',
      onCard: true,
      choices: [
         { key: 'essence', label: t('Essence', 'Petrol', 'Gasolina', 'Gasolina', '汽油', 'بنزين', 'Бензин') },
         { key: 'diesel', label: t('Diesel', 'Diesel', 'Diesel', 'Diésel', '柴油', 'ديزل', 'Дизель') },
         { key: 'hybride', label: t('Hybride', 'Hybrid', 'Híbrido', 'Híbrido', '混合动力', 'هجين', 'Гибрид') },
         { key: 'electrique', label: t('Électrique', 'Electric', 'Elétrico', 'Eléctrico', '电动', 'كهربائي', 'Электро') },
      ],
   },
   {
      key: 'transmission',
      name: t('Transmission', 'Drive', 'Tração', 'Tracción', '驱动方式', 'نظام الدفع', 'Привод'),
      valueType: 'CHOICE',
      choices: [
         { key: '2-roues-motrices', label: t('2 roues motrices', '2WD', 'Tração 4x2', 'Tracción 4x2', '两驱', 'دفع ثنائي', 'Монопривод') },
         { key: '4x4', label: t('4x4', '4x4', '4x4', '4x4', '四驱', 'دفع رباعي', '4x4') },
         { key: 'integrale', label: t('Intégrale', 'All-wheel drive', 'Tração integral', 'Tracción integral', '全时四驱', 'دفع كلي', 'Постоянный полный привод') },
      ],
   },
   {
      key: 'volant',
      name: t('Volant', 'Steering', 'Volante', 'Volante', '方向盘', 'المقود', 'Руль'),
      valueType: 'CHOICE',
      choices: [
         { key: 'gauche', label: t('Gauche', 'Left-hand', 'À esquerda', 'A la izquierda', '左舵', 'يسار', 'Левый') },
         { key: 'droite', label: t('Droite', 'Right-hand', 'À direita', 'A la derecha', '右舵', 'يمين', 'Правый') },
      ],
   },
   {
      key: 'cylindree',
      name: t('Cylindrée', 'Engine size', 'Cilindrada', 'Cilindrada', '排量', 'سعة المحرك', 'Объём двигателя'),
      valueType: 'NUMBER',
      unit: 'cc',
      onCard: true,
   },
   { key: 'places', name: t('Places', 'Seats', 'Lugares', 'Plazas', '座位数', 'عدد المقاعد', 'Мест'), valueType: 'NUMBER' },
   { key: 'portes', name: t('Portes', 'Doors', 'Portas', 'Puertas', '车门数', 'عدد الأبواب', 'Дверей'), valueType: 'NUMBER' },
   {
      key: 'puissance',
      name: t('Puissance', 'Power', 'Potência', 'Potencia', '功率', 'القوة', 'Мощность'),
      valueType: 'NUMBER',
      unit: 'ch',
   },
]

const COMFORT = t('Confort', 'Comfort', 'Conforto', 'Confort', '舒适', 'الراحة', 'Комфорт')
const SAFETY = t('Sécurité', 'Safety', 'Segurança', 'Seguridad', '安全', 'الأمان', 'Безопасность')
const MEDIA = t('Multimédia', 'Multimedia', 'Multimídia', 'Multimedia', '多媒体', 'الوسائط المتعددة', 'Мультимедиа')
const OUTSIDE = t('Extérieur', 'Exterior', 'Exterior', 'Exterior', '外观', 'المظهر الخارجي', 'Экстерьер')
const UTILITY = t('Utilitaire', 'Utility', 'Utilitários', 'Utilitario', '实用配置', 'تجهيزات عملية', 'Практичность')

export const STARTER_ACCESSORIES: { key: string; name: Localized; group: Localized }[] = [
   { key: 'climatisation', group: COMFORT, name: t('Climatisation', 'Air conditioning', 'Ar-condicionado', 'Aire acondicionado', '空调', 'تكييف الهواء', 'Кондиционер') },
   { key: 'direction-assistee', group: COMFORT, name: t('Direction assistée', 'Power steering', 'Direção assistida', 'Dirección asistida', '助力转向', 'مقود معزز', 'Гидроусилитель руля') },
   { key: 'vitres-electriques', group: COMFORT, name: t('Vitres électriques', 'Power windows', 'Vidros elétricos', 'Elevalunas eléctricos', '电动车窗', 'نوافذ كهربائية', 'Электростеклоподъёмники') },
   { key: 'verrouillage-centralise', group: SAFETY, name: t('Verrouillage centralisé', 'Central locking', 'Travamento central', 'Cierre centralizado', '中控锁', 'قفل مركزي', 'Центральный замок') },
   { key: 'abs', group: SAFETY, name: t('ABS', 'ABS', 'ABS', 'ABS', 'ABS 防抱死', 'نظام ABS', 'ABS') },
   { key: 'airbags', group: SAFETY, name: t('Airbags', 'Airbags', 'Airbags', 'Airbags', '安全气囊', 'وسائد هوائية', 'Подушки безопасности') },
   { key: 'camera-de-recul', group: SAFETY, name: t('Caméra de recul', 'Reversing camera', 'Câmera de ré', 'Cámara de marcha atrás', '倒车影像', 'كاميرا خلفية', 'Камера заднего вида') },
   { key: 'radar-de-recul', group: SAFETY, name: t('Radar de recul', 'Parking sensors', 'Sensor de estacionamento', 'Sensores de aparcamiento', '倒车雷达', 'حساسات الركن', 'Парктроник') },
   { key: 'gps', group: MEDIA, name: t('GPS', 'GPS navigation', 'GPS', 'GPS', 'GPS 导航', 'نظام GPS', 'GPS-навигация') },
   { key: 'bluetooth', group: MEDIA, name: t('Bluetooth', 'Bluetooth', 'Bluetooth', 'Bluetooth', '蓝牙', 'بلوتوث', 'Bluetooth') },
   { key: 'ecran-tactile', group: MEDIA, name: t('Écran tactile', 'Touchscreen', 'Tela sensível ao toque', 'Pantalla táctil', '触摸屏', 'شاشة لمس', 'Сенсорный экран') },
   { key: 'sieges-cuir', group: COMFORT, name: t('Sièges cuir', 'Leather seats', 'Bancos de couro', 'Asientos de cuero', '真皮座椅', 'مقاعد جلدية', 'Кожаные сиденья') },
   { key: 'toit-ouvrant', group: COMFORT, name: t('Toit ouvrant', 'Sunroof', 'Teto solar', 'Techo solar', '天窗', 'فتحة سقف', 'Люк в крыше') },
   { key: 'jantes-alliage', group: OUTSIDE, name: t('Jantes alliage', 'Alloy wheels', 'Jantes de liga leve', 'Llantas de aleación', '铝合金轮毂', 'جنوط ألمنيوم', 'Литые диски') },
   { key: 'regulateur-de-vitesse', group: COMFORT, name: t('Régulateur de vitesse', 'Cruise control', 'Piloto automático', 'Control de crucero', '定速巡航', 'مثبت السرعة', 'Круиз-контроль') },
   { key: 'demarrage-sans-cle', group: COMFORT, name: t('Démarrage sans clé', 'Keyless start', 'Partida sem chave', 'Arranque sin llave', '一键启动', 'تشغيل بدون مفتاح', 'Бесключевой запуск') },
   { key: 'treuil', group: UTILITY, name: t('Treuil', 'Winch', 'Guincho', 'Cabrestante', '绞盘', 'ونش', 'Лебёдка') },
   { key: 'attelage', group: UTILITY, name: t('Attelage', 'Tow bar', 'Engate de reboque', 'Enganche de remolque', '拖车钩', 'وصلة قطر', 'Фаркоп') },
]
