import { apiUrl, authFetch } from '../utils/storage';

/**
 * 语音播报音色(edge-tts)配置读写。
 *
 * 垫片(tools/edge-tts/shim/tts_shim.py)每次合成时按语言前缀查音色,优先级:
 *   voices.local.json(本模块写的用户覆盖)> voices.json(入库默认)
 * 这里通过通用文件 API 读写 voices.local.json,服务端零改动。落盘位置发现
 * 用 /api/files/exists:只走严格 resolveAndValidateFilePath(无 fallback 策略,
 * 不会误命中其它目录),文件不存在时也返回解析后的绝对路径;/api/files/write
 * 要求绝对路径且文件已存在,故缺失时先 /create。
 */

export type TtsLang = 'zh' | 'en' | 'es';

/** 播报引擎:edge-tts(微软在线,免费)/ volcano(火山引擎·豆包大模型 TTS,按字符计费)。 */
export type TtsEngine = 'edge-tts' | 'volcano';

/** 火山音色(按语言);**空串 = 该语言回退 edge-tts**(与上方 edge 音色字段语义相反:
 *  edge 字段空串 = 保持默认,这里空串是设置页「不用火山 · 回退 edge-tts」的有效选择)。 */
export interface VolcanoVoices {
  zh: string;
  en: string;
  es: string;
}

export interface TtsVoiceConfig {
  zh: string;
  en: string;
  es: string;
  /** 当前播报引擎;老配置无此字段 = edge-tts(等价历史行为)。 */
  engine: TtsEngine;
  volcano: VolcanoVoices;
  /** 语速调整(百分数,0 = 原速;+10 = 快 10%)。 */
  rate: number;
  /** 音量调整(百分数,0 = 原音量)。 */
  volume: number;
  /** 火山合成专用 API Key;留空 = 复用「语音伙伴」config.json 的凭据(推荐)。 */
  volcanoApiKey: string;
  /** 火山 resource 覆盖;留空 = 垫片按当前音色自动推导(uranus→seed-tts-2.0,其余 1.0)。 */
  volcanoResourceId: string;
}

export interface TtsVoiceOption {
  value: string;
  label: string;
}

/** 音色分组(设置页渲染为 <optgroup>;group 为空串 = 平铺,用于 edge 列表)。 */
export interface TtsVoiceGroup {
  group: string;
  options: readonly TtsVoiceOption[];
}

/** 与 tools/edge-tts/voices.json 的出厂默认保持一致(rate/volume 缺省 = 0)。 */
export const DEFAULT_TTS_VOICES: TtsVoiceConfig = {
  zh: 'zh-CN-XiaoxiaoNeural',
  en: 'en-US-JennyNeural',
  es: 'es-MX-DaliaNeural',
  engine: 'edge-tts',
  volcano: {
    zh: 'zh_female_shuangkuaisisi_moon_bigtts',
    en: 'en_male_tim_uranus_bigtts',
    es: '',
  },
  rate: 0,
  volume: 0,
  volcanoApiKey: '',
  volcanoResourceId: '',
};

/** edge-tts 实际可用的音色(msedge 列表,非 Azure 全量)。 */
export const TTS_VOICE_OPTIONS: Record<TtsLang, readonly TtsVoiceOption[]> = {
  zh: [
    { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声(默认)' },
    { value: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼女声' },
    { value: 'zh-CN-YunxiNeural', label: '云希 · 阳光男声' },
    { value: 'zh-CN-YunyangNeural', label: '云扬 · 新闻男声' },
    { value: 'zh-CN-YunjianNeural', label: '云健 · 激情男声' },
    { value: 'zh-CN-YunxiaNeural', label: '云夏 · 可爱童声' },
    { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北话' },
    { value: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西话' },
    { value: 'zh-HK-HiuGaaiNeural', label: '晓佳 · 粤语女声' },
    { value: 'zh-HK-HiuMaanNeural', label: '晓曼 · 粤语女声' },
    { value: 'zh-HK-WanLungNeural', label: '云龙 · 粤语男声' },
    { value: 'zh-TW-HsiaoChenNeural', label: '晓臻 · 台湾女声' },
    { value: 'zh-TW-HsiaoYuNeural', label: '晓雨 · 台湾女声' },
    { value: 'zh-TW-YunJheNeural', label: '云哲 · 台湾男声' },
  ],
  en: [
    { value: 'en-US-JennyNeural', label: 'Jenny · 亲切女声(默认)' },
    { value: 'en-US-AriaNeural', label: 'Aria · 自信女声' },
    { value: 'en-US-AvaNeural', label: 'Ava · 友好女声' },
    { value: 'en-US-EmmaNeural', label: 'Emma · 开朗女声' },
    { value: 'en-US-MichelleNeural', label: 'Michelle · 温柔女声' },
    { value: 'en-US-AnaNeural', label: 'Ana · 童声' },
    { value: 'en-US-AndrewNeural', label: 'Andrew · 沉稳男声' },
    { value: 'en-US-BrianNeural', label: 'Brian · 随和男声' },
    { value: 'en-US-ChristopherNeural', label: 'Christopher · 权威男声' },
    { value: 'en-US-GuyNeural', label: 'Guy · 激情男声' },
    { value: 'en-US-RogerNeural', label: 'Roger · 活泼男声' },
    { value: 'en-US-SteffanNeural', label: 'Steffan · 理性男声' },
  ],
  es: [
    { value: 'es-MX-DaliaNeural', label: 'Dalia · 墨西哥女声(默认)' },
    { value: 'es-MX-JorgeNeural', label: 'Jorge · 墨西哥男声' },
    { value: 'es-ES-ElviraNeural', label: 'Elvira · 西班牙女声' },
    { value: 'es-ES-AlvaroNeural', label: 'Alvaro · 西班牙男声' },
    { value: 'es-US-PalomaNeural', label: 'Paloma · 美国西语女声' },
    { value: 'es-AR-ElenaNeural', label: 'Elena · 阿根廷女声' },
  ],
};

/**
 * 火山引擎音色:官方 2.0 音色库 285 个候选于 2026-10-14 本机逐个实测,284 个可用入表
 * (唯一排除:清爽男大 zh_male_qingshuangnanda_uranus_bigtts,服务端稳定超时)。
 * 1.0 = seed-tts-1.0,2.0 = seed-tts-2.0,垫片按音色名后缀 moon/mars↔uranus 自动选
 * resource;「角色扮演 · *」= ICL 系(tob 音色,走 2.0 resource,实测全部可用),
 * 排在列表最后。西语无火山专用音色 → 只有回退项。音色语言不匹配(如英文音色读中文)时
 * 服务端返回零音频,垫片会自动回退 edge-tts。按场景分组渲染为 <optgroup>。
 */
export const VOLCANO_VOICE_GROUPS: Record<TtsLang, readonly TtsVoiceGroup[]> = {
  zh: [
    {
      group: '1.0 · 音色',
      options: [
        { value: 'zh_female_shuangkuaisisi_moon_bigtts', label: '爽快思思 · 活泼女声' },
        { value: 'zh_female_gaolengyujie_moon_bigtts', label: '高冷御姐' },
        { value: 'zh_female_meilinvyou_moon_bigtts', label: '魅力女友' },
        { value: 'zh_female_wanwanxiaohe_moon_bigtts', label: '湾湾小何' },
        { value: 'zh_male_jingqiangkanye_moon_bigtts', label: '京腔侃爷' },
        { value: 'zh_male_beijingxiaoye_moon_bigtts', label: '北京小爷' },
        { value: 'zh_male_yangguangqingnian_moon_bigtts', label: '阳光青年' },
        { value: 'zh_male_beijingxiaoye_emo_v2_mars_bigtts', label: '北京小爷 · 情感版' },
        { value: 'zh_female_wanqudashu_moon_bigtts', label: '弯曲大树' },
      ],
    },
    {
      group: '2.0 · 通用',
      options: [
        { value: 'zh_female_vv_uranus_bigtts', label: 'Vivi' },
        { value: 'zh_female_xiaohe_uranus_bigtts', label: '小何' },
        { value: 'zh_male_m191_uranus_bigtts', label: '云舟' },
        { value: 'zh_male_taocheng_uranus_bigtts', label: '小天' },
        { value: 'zh_male_liufei_uranus_bigtts', label: '刘飞' },
        { value: 'zh_female_sophie_uranus_bigtts', label: '魅力苏菲' },
        { value: 'zh_female_qingxinnvsheng_uranus_bigtts', label: '清新女声' },
        { value: 'zh_female_tianmeixiaoyuan_uranus_bigtts', label: '甜美小源' },
        { value: 'zh_female_tianmeitaozi_uranus_bigtts', label: '甜美桃子' },
        { value: 'zh_female_shuangkuaisisi_uranus_bigtts', label: '爽快思思' },
        { value: 'zh_female_linjianvhai_uranus_bigtts', label: '邻家女孩' },
        { value: 'zh_male_shaonianzixin_uranus_bigtts', label: '少年梓辛/Brayan' },
        { value: 'zh_male_linjiananhai_uranus_bigtts', label: '邻家男孩' },
        { value: 'zh_male_ruyaqingnian_uranus_bigtts', label: '儒雅青年' },
        { value: 'zh_male_wennuanahu_uranus_bigtts', label: '温暖阿虎/Alvin' },
        { value: 'zh_male_naiqimengwa_uranus_bigtts', label: '奶气萌娃' },
        { value: 'zh_female_popo_uranus_bigtts', label: '婆婆' },
        { value: 'zh_female_gaolengyujie_uranus_bigtts', label: '高冷御姐' },
        { value: 'zh_male_aojiaobazong_uranus_bigtts', label: '傲娇霸总' },
        { value: 'zh_male_fanjuanqingnian_uranus_bigtts', label: '反卷青年' },
        { value: 'zh_female_wenroushunv_uranus_bigtts', label: '温柔淑女' },
        { value: 'zh_male_huolixiaoge_uranus_bigtts', label: '活力小哥' },
        { value: 'zh_female_mengyatou_uranus_bigtts', label: '萌丫头/Cutey' },
        { value: 'zh_female_tiexinnvsheng_uranus_bigtts', label: '贴心女声/Candy' },
        { value: 'zh_female_jitangmei_uranus_bigtts', label: '鸡汤妹妹/Hope' },
        { value: 'zh_male_cixingjieshuonan_uranus_bigtts', label: '磁性解说男声/Morgan' },
        { value: 'zh_male_liangsangmengzai_uranus_bigtts', label: '亮嗓萌仔' },
        { value: 'zh_female_kailangjiejie_uranus_bigtts', label: '开朗姐姐' },
        { value: 'zh_male_gaolengchenwen_uranus_bigtts', label: '高冷沉稳' },
        { value: 'zh_male_shenyeboke_uranus_bigtts', label: '深夜播客' },
        { value: 'zh_male_kailangdidi_uranus_bigtts', label: '开朗弟弟' },
        { value: 'zh_female_qinqienv_uranus_bigtts', label: '亲切女声' },
        { value: 'zh_male_kuailexiaodong_uranus_bigtts', label: '快乐小东' },
        { value: 'zh_male_kailangxuezhang_uranus_bigtts', label: '开朗学长' },
        { value: 'zh_male_youyoujunzi_uranus_bigtts', label: '悠悠君子' },
        { value: 'zh_female_wenjingmaomao_uranus_bigtts', label: '文静毛毛' },
        { value: 'zh_female_zhixingnv_uranus_bigtts', label: '知性女声' },
        { value: 'zh_male_yuanboxiaoshu_uranus_bigtts', label: '渊博小叔' },
        { value: 'zh_male_yangguangqingnian_uranus_bigtts', label: '阳光青年' },
        { value: 'zh_female_qingchezizi_uranus_bigtts', label: '清澈梓梓' },
        { value: 'zh_female_tianmeiyueyue_uranus_bigtts', label: '甜美悦悦' },
        { value: 'zh_female_xinlingjitang_uranus_bigtts', label: '心灵鸡汤' },
        { value: 'zh_male_wenrouxiaoge_uranus_bigtts', label: '温柔小哥' },
        { value: 'zh_female_roumeinvyou_uranus_bigtts', label: '柔美女友' },
        { value: 'zh_male_dongfanghaoran_uranus_bigtts', label: '东方浩然' },
        { value: 'zh_female_wenrouxiaoya_uranus_bigtts', label: '温柔小雅' },
        { value: 'zh_male_tiancaitongsheng_uranus_bigtts', label: '天才童声' },
        { value: 'zh_male_guanggaojieshuo_uranus_bigtts', label: '广告解说' },
        { value: 'zh_male_jieshuoxiaoming_uranus_bigtts', label: '解说小明' },
        { value: 'zh_female_tvbnv_uranus_bigtts', label: 'TVB女声' },
        { value: 'zh_male_yizhipiannan_uranus_bigtts', label: '译制片男' },
        { value: 'zh_female_qiaopinv_uranus_bigtts', label: '俏皮女声' },
        { value: 'zh_female_jiaochuannv_uranus_bigtts', label: '娇喘女声' },
        { value: 'zh_female_chanmeinv_uranus_bigtts', label: '谄媚女声' },
        { value: 'zh_female_meilinvyou_uranus_bigtts', label: '魅力女友' },
        { value: 'zh_female_wenroumama_uranus_bigtts', label: '温柔妈妈' },
      ],
    },
    {
      group: '2.0 · 视频配音',
      options: [
        { value: 'zh_female_peiqi_uranus_bigtts', label: '佩奇猪' },
        { value: 'zh_male_sunwukong_uranus_bigtts', label: '猴哥' },
        { value: 'zh_male_dayi_uranus_bigtts', label: '大壹' },
        { value: 'zh_female_mizai_uranus_bigtts', label: '黑猫侦探社咪仔' },
        { value: 'zh_female_jitangnv_uranus_bigtts', label: '鸡汤女' },
        { value: 'zh_female_liuchangnv_uranus_bigtts', label: '流畅女声' },
        { value: 'zh_male_ruyayichen_uranus_bigtts', label: '儒雅逸辰' },
      ],
    },
    {
      group: '2.0 · 有声阅读',
      options: [
        { value: 'zh_female_xiaoxue_uranus_bigtts', label: '儿童绘本' },
        { value: 'zh_male_baqiqingshu_uranus_bigtts', label: '霸气青叔' },
        { value: 'zh_male_xuanyijieshuo_uranus_bigtts', label: '悬疑解说' },
        { value: 'zh_female_shaoergushi_uranus_bigtts', label: '少儿故事' },
      ],
    },
    {
      group: '2.0 · 教育',
      options: [
        { value: 'zh_female_yingyujiaoxue_uranus_bigtts', label: 'Tina老师' },
      ],
    },
    {
      group: '2.0 · 客服',
      options: [
        { value: 'zh_female_kefunvsheng_uranus_bigtts', label: '暖阳女声' },
      ],
    },
    {
      group: '2.0 · 角色',
      options: [
        { value: 'zh_female_cancan_uranus_bigtts', label: '知性灿灿' },
        { value: 'zh_female_sajiaoxuemei_uranus_bigtts', label: '撒娇学妹' },
        { value: 'zh_female_zhishuaiyingzi_uranus_bigtts', label: '直率英子' },
        { value: 'zh_male_silang_uranus_bigtts', label: '四郎' },
        { value: 'zh_male_qingcang_uranus_bigtts', label: '擎苍' },
        { value: 'zh_male_xionger_uranus_bigtts', label: '熊二' },
        { value: 'zh_female_yingtaowanzi_uranus_bigtts', label: '樱桃丸子' },
        { value: 'zh_male_lanyinmianbao_uranus_bigtts', label: '懒音绵宝' },
        { value: 'zh_female_gufengshaoyu_uranus_bigtts', label: '古风少御' },
        { value: 'zh_male_lubanqihao_uranus_bigtts', label: '鲁班七号' },
        { value: 'zh_female_linxiao_uranus_bigtts', label: '林潇' },
        { value: 'zh_female_lingling_uranus_bigtts', label: '玲玲姐姐' },
        { value: 'zh_female_chunribu_uranus_bigtts', label: '春日部姐姐' },
        { value: 'zh_male_tangseng_uranus_bigtts', label: '唐僧' },
        { value: 'zh_male_zhuangzhou_uranus_bigtts', label: '庄周' },
        { value: 'zh_male_zhubajie_uranus_bigtts', label: '猪八戒' },
        { value: 'zh_female_ganmaodianyin_uranus_bigtts', label: '感冒电音姐姐' },
        { value: 'zh_female_nvleishen_uranus_bigtts', label: '女雷神' },
        { value: 'zh_female_wuzetian_uranus_bigtts', label: '武则天' },
        { value: 'zh_female_gujie_uranus_bigtts', label: '顾姐' },
      ],
    },
    {
      group: '角色扮演 · 有声阅读',
      options: [
        { value: 'ICL_uranus_zh_male_ruyagongzi_tob', label: '儒雅公子' },
        { value: 'ICL_uranus_zh_male_neiliancaijun_tob', label: '内敛才俊' },
        { value: 'ICL_uranus_zh_male_wennuanshaonian_tob', label: '温暖少年' },
      ],
    },
    {
      group: '角色扮演 · 客服',
      options: [
        { value: 'ICL_uranus_zh_female_guaiqiaokeer_tob', label: '乖巧可儿' },
        { value: 'ICL_uranus_zh_female_kailangtingting_tob', label: '开朗婷婷' },
        { value: 'ICL_uranus_zh_female_kaixinxiaohong_tob', label: '开心小鸿' },
        { value: 'ICL_uranus_zh_female_lingdongxinxin_tob', label: '灵动欣欣' },
        { value: 'ICL_uranus_zh_female_lixingyuanzi_tob', label: '理性圆子' },
        { value: 'ICL_uranus_zh_female_nuanxinqianqian_tob', label: '暖心茜茜' },
        { value: 'ICL_uranus_zh_female_qingtianmeimei_tob', label: '清甜莓莓' },
        { value: 'ICL_uranus_zh_female_qingtiantaotao_tob', label: '清甜桃桃' },
        { value: 'ICL_uranus_zh_female_qingxixiaoxue_tob', label: '清晰小雪' },
        { value: 'ICL_uranus_zh_female_ruanmengtangtang_tob', label: '软萌糖糖' },
        { value: 'ICL_uranus_zh_female_ruanmengtuanzi_tob', label: '软萌团子' },
        { value: 'ICL_uranus_zh_female_tianmeixiaoju_tob', label: '甜美小橘' },
        { value: 'ICL_uranus_zh_female_tianmeixiaoyu_tob', label: '甜美小雨' },
        { value: 'ICL_uranus_zh_female_xiuliqianqian_tob', label: '秀丽倩倩' },
        { value: 'ICL_uranus_zh_male_chenwenmingzai_tob', label: '沉稳明仔' },
        { value: 'ICL_uranus_zh_male_qingxinbobo_tob', label: '清新波波' },
        { value: 'ICL_uranus_zh_male_qinqiexiaozhuo_tob', label: '亲切小卓' },
        { value: 'ICL_uranus_zh_male_shuanglangxiaoyang_tob', label: '爽朗小阳' },
        { value: 'ICL_uranus_zh_male_yangguangyangyang_tob', label: '阳光洋洋' },
        { value: 'ICL_uranus_zh_male_qingxinmumu_tob', label: '清新沐沐' },
        { value: 'ICL_uranus_zh_female_wenwanshanshan_tob', label: '温婉珊珊' },
        { value: 'ICL_uranus_zh_female_reqingaina_tob', label: '热情艾娜' },
        { value: 'ICL_uranus_zh_female_qingyingduoduo_tob', label: '轻盈朵朵' },
      ],
    },
    {
      group: '角色扮演 · 中文',
      options: [
        { value: 'ICL_uranus_zh_female_aojiaonvyou_tob', label: '傲娇女友' },
        { value: 'ICL_uranus_zh_female_xiemeinvwang_tob', label: '邪魅女王' },
        { value: 'ICL_uranus_zh_female_bingjiaojiejie_tob', label: '病娇姐姐' },
        { value: 'ICL_uranus_zh_female_bingjiaomengmei_tob', label: '病娇萌妹' },
        { value: 'ICL_uranus_zh_female_chengshuwenrou_tob', label: '成熟温柔' },
        { value: 'ICL_uranus_zh_female_chengshujiejie_tob', label: '成熟姐姐' },
        { value: 'ICL_uranus_zh_female_chunzhenshaonv_tob', label: '纯真少女' },
        { value: 'ICL_uranus_zh_female_chunchenvsheng_tob', label: '纯澈女生' },
        { value: 'ICL_uranus_zh_female_wumeikeren_tob', label: '妩媚可人' },
        { value: 'ICL_uranus_zh_female_heainainai_tob', label: '和蔼奶奶' },
        { value: 'ICL_uranus_zh_female_huopodiaoman_tob', label: '活泼刁蛮' },
        { value: 'ICL_uranus_zh_female_jiaohannvwang_tob', label: '娇憨女王' },
        { value: 'ICL_uranus_zh_female_jiaoruoluoli_tob', label: '娇弱萝莉' },
        { value: 'ICL_uranus_zh_female_jiaxiaozi_tob', label: '假小子' },
        { value: 'ICL_uranus_zh_female_jinglingxiangdao_tob', label: '精灵向导' },
        { value: 'ICL_uranus_zh_female_keainvsheng_tob', label: '可爱女生' },
        { value: 'ICL_uranus_zh_female_linjuayi_tob', label: '邻居阿姨' },
        { value: 'ICL_uranus_zh_female_tianmeijiaoqiao_tob', label: '甜美娇俏' },
        { value: 'ICL_uranus_zh_female_qinglenggaoya_tob', label: '清冷高雅' },
        { value: 'ICL_uranus_zh_female_xingganmeihuo_tob', label: '性感魅惑' },
        { value: 'ICL_uranus_zh_female_nuanxinxuejie_tob', label: '暖心学姐' },
        { value: 'ICL_uranus_zh_female_qingxinshaonv_tob', label: '倾心少女' },
        { value: 'ICL_uranus_zh_female_rouguhunshi_tob', label: '柔骨魂师' },
        { value: 'ICL_uranus_zh_female_tianmeihuopo_tob', label: '甜美活泼' },
        { value: 'ICL_uranus_zh_female_tiaopigongzhu_tob', label: '调皮公主' },
        { value: 'ICL_uranus_zh_female_tiexinnvyou_tob', label: '贴心女友' },
        { value: 'ICL_uranus_zh_female_wenrounvshen_tob', label: '温柔女神' },
        { value: 'ICL_uranus_zh_female_wenrouwenya_tob', label: '温柔文雅' },
        { value: 'ICL_uranus_zh_female_zhixinjiejie_tob', label: '知心姐姐' },
        { value: 'ICL_uranus_zh_female_wumeiyujie_tob', label: '妩媚御姐' },
        { value: 'ICL_uranus_zh_female_yuanqitianmei_tob', label: '元气甜妹' },
        { value: 'ICL_uranus_zh_female_xiemeiyujie_tob', label: '邪魅御姐' },
        { value: 'ICL_uranus_zh_female_xingganyujie_tob', label: '性感御姐' },
        { value: 'ICL_uranus_zh_female_tiexinguimi_tob', label: '贴心闺蜜' },
        { value: 'ICL_uranus_zh_female_tiexinmeimei_tob', label: '贴心妹妹' },
        { value: 'ICL_uranus_zh_female_wenroubaiyueguang_tob', label: '温柔白月光' },
        { value: 'ICL_uranus_zh_female_chuliannvyou_tob', label: '初恋女友' },
        { value: 'ICL_uranus_zh_female_zhixingwenwan_tob', label: '知性温婉' },
        { value: 'ICL_uranus_zh_male_aoqilingren_tob', label: '傲气凌人' },
        { value: 'ICL_uranus_zh_male_anrenqinzhu_tob', label: '黯刃秦主' },
        { value: 'ICL_uranus_zh_male_aojiaogongzi_tob', label: '傲娇公子' },
        { value: 'ICL_uranus_zh_male_aojiaojingying_tob', label: '傲娇精英' },
        { value: 'ICL_uranus_zh_male_aomanqingnian_tob', label: '傲慢青年' },
        { value: 'ICL_uranus_zh_male_aomanshaoye_tob', label: '傲慢少爷' },
        { value: 'ICL_uranus_zh_male_zhenbiandiyu_tob', label: '枕边低语' },
        { value: 'ICL_uranus_zh_male_badaoshaoye_tob', label: '霸道少爷' },
        { value: 'ICL_uranus_zh_male_badaozongcai_tob', label: '霸道总裁' },
        { value: 'ICL_uranus_zh_male_bingjiaobailian_tob', label: '病娇白莲' },
        { value: 'ICL_uranus_zh_male_bingjiaodidi_tob', label: '病娇弟弟' },
        { value: 'ICL_uranus_zh_male_bingjiaogege_tob', label: '病娇哥哥' },
        { value: 'ICL_uranus_zh_male_bingjiaonanyou_tob', label: '病娇男友' },
        { value: 'ICL_uranus_zh_male_bingjiaoshaonian_tob', label: '病娇少年' },
        { value: 'ICL_uranus_zh_male_bingruogongzi_tob', label: '病弱公子' },
        { value: 'ICL_uranus_zh_male_bingruoshaonian_tob', label: '病弱少年' },
        { value: 'ICL_uranus_zh_male_bujiqingnian_tob', label: '不羁青年' },
        { value: 'ICL_uranus_zh_male_chunhoudiyin_tob', label: '醇厚低音' },
        { value: 'ICL_uranus_zh_male_paoxiaoxiaoge_tob', label: '咆哮小哥' },
        { value: 'ICL_uranus_zh_male_yangyang_tob', label: '炀炀' },
        { value: 'ICL_uranus_zh_male_chanruoshaoye_tob', label: '孱弱少爷' },
        { value: 'ICL_uranus_zh_male_chengshuzongcai_tob', label: '成熟总裁' },
        { value: 'ICL_uranus_zh_male_qingyisugan_tob', label: '清逸苏感' },
        { value: 'ICL_uranus_zh_male_chunzhenxuedi_tob', label: '纯真学弟' },
        { value: 'ICL_uranus_zh_male_cixingnansang_tob', label: '磁性男嗓' },
        { value: 'ICL_uranus_zh_male_cujingnansheng_tob', label: '醋精男生' },
        { value: 'ICL_uranus_zh_male_cujingnanyou_tob', label: '醋精男友' },
        { value: 'ICL_uranus_zh_male_diyinchenyu_tob', label: '低音沉郁' },
        { value: 'ICL_uranus_zh_male_fengfashaonian_tob', label: '风发少年' },
        { value: 'ICL_uranus_zh_male_fuheigongzi_tob', label: '腹黑公子' },
        { value: 'ICL_uranus_zh_male_ganjingshaonian_tob', label: '干净少年' },
        { value: 'ICL_uranus_zh_male_gaolengzongcai_tob', label: '高冷总裁' },
        { value: 'ICL_uranus_zh_male_guaogongzi_tob', label: '孤傲公子' },
        { value: 'ICL_uranus_zh_male_gugaogongzi_tob', label: '孤高公子' },
        { value: 'ICL_uranus_zh_male_guiyishenmi_tob', label: '诡异神秘' },
        { value: 'ICL_uranus_zh_male_guzhibingjiao_tob', label: '固执病娇' },
        { value: 'ICL_uranus_zh_male_hanhoudunshi_tob', label: '憨厚敦实' },
        { value: 'ICL_uranus_zh_male_huoliqingnian_tob', label: '活力青年' },
        { value: 'ICL_uranus_zh_male_huoponanyou_tob', label: '活泼男友' },
        { value: 'ICL_uranus_zh_male_huoposhuanglang_tob', label: '活泼爽朗' },
        { value: 'ICL_uranus_zh_male_huzishushu_tob', label: '胡子叔叔' },
        { value: 'ICL_uranus_zh_male_jijiazhineng_tob', label: '机甲智能' },
        { value: 'ICL_uranus_zh_male_jingyingqingnian_tob', label: '精英青年' },
        { value: 'ICL_uranus_zh_male_junyigongzi_tob', label: '俊逸公子' },
        { value: 'ICL_uranus_zh_male_kailangqingkuai_tob', label: '开朗轻快' },
        { value: 'ICL_uranus_zh_male_kailangqingnian_tob', label: '开朗青年' },
        { value: 'ICL_uranus_zh_male_lanyincaohunshi_tob', label: '蓝银草魂师' },
        { value: 'ICL_uranus_zh_male_lengaozongcai_tob', label: '冷傲总裁' },
        { value: 'ICL_uranus_zh_male_lengdanshuli_tob', label: '冷淡疏离' },
        { value: 'ICL_uranus_zh_male_lengjungaozhi_tob', label: '冷峻高智' },
        { value: 'ICL_uranus_zh_male_lengjunshangsi_tob', label: '冷峻上司' },
        { value: 'ICL_uranus_zh_male_lengkugege_tob', label: '冷酷哥哥' },
        { value: 'ICL_uranus_zh_male_lenglianxiongzhang_tob', label: '冷脸兄长' },
        { value: 'ICL_uranus_zh_male_lenglianxueba_tob', label: '冷脸学霸' },
        { value: 'ICL_uranus_zh_male_lengmonanyou_tob', label: '冷漠男友' },
        { value: 'ICL_uranus_zh_male_lengmoxiongzhang_tob', label: '冷漠兄长' },
        { value: 'ICL_uranus_zh_male_lingyunqingnian_tob', label: '凌云青年' },
        { value: 'ICL_uranus_zh_male_qinglengjingui_tob', label: '清冷矜贵' },
        { value: 'ICL_uranus_zh_male_lvchaxiaoge_tob', label: '绿茶小哥' },
        { value: 'ICL_uranus_zh_male_mengdongqingnian_tob', label: '懵懂青年' },
        { value: 'ICL_uranus_zh_male_menyoupingxiaoge_tob', label: '闷油瓶小哥' },
        { value: 'ICL_uranus_zh_male_xiaozhangxiaoge_tob', label: '嚣张小哥' },
        { value: 'ICL_uranus_zh_male_nianrennanyou_tob', label: '粘人男友' },
        { value: 'ICL_uranus_zh_male_nuanxintitie_tob', label: '暖心体贴' },
        { value: 'ICL_uranus_zh_male_pianpiangongzi_tob', label: '翩翩公子' },
        { value: 'ICL_uranus_zh_male_chenwenyouya_tob', label: '沉稳优雅' },
        { value: 'ICL_uranus_zh_male_qingsexiaosheng_tob', label: '青涩小生' },
        { value: 'ICL_uranus_zh_male_qingseqingnian_tob', label: '青涩青年' },
        { value: 'ICL_uranus_zh_male_qingshuangshaonian_tob', label: '清爽少年' },
        { value: 'ICL_uranus_zh_male_qinqieqingnian_tob', label: '亲切青年' },
        { value: 'ICL_uranus_zh_male_qinglangwenrun_tob', label: '清朗温润' },
        { value: 'ICL_uranus_zh_male_rexueshaonian_tob', label: '热血少年' },
        { value: 'ICL_uranus_zh_male_ruyacaijun_tob', label: '儒雅才俊' },
        { value: 'ICL_uranus_zh_male_ruyajunzi_tob', label: '儒雅君子' },
        { value: 'ICL_uranus_zh_male_ruyazongcai_tob', label: '儒雅总裁' },
        { value: 'ICL_uranus_zh_male_sajiaonansheng_tob', label: '撒娇男生' },
        { value: 'ICL_uranus_zh_male_sajiaonanyou_tob', label: '撒娇男友' },
        { value: 'ICL_uranus_zh_male_sajiaonianren_tob', label: '撒娇粘人' },
        { value: 'ICL_uranus_zh_male_satuoqingnian_tob', label: '洒脱青年' },
        { value: 'ICL_uranus_zh_male_shaonianjiangjun_tob', label: '少年将军' },
        { value: 'ICL_uranus_zh_male_shenchenzongcai_tob', label: '深沉总裁' },
        { value: 'ICL_uranus_zh_male_jilingxiaohuo_tob', label: '机灵小伙' },
        { value: 'ICL_uranus_zh_male_shenmifashi_tob', label: '神秘法师' },
        { value: 'ICL_uranus_zh_male_shuaizhenxiaohuo_tob', label: '率真小伙' },
        { value: 'ICL_uranus_zh_male_dichenqianquan_tob', label: '低沉缱绻' },
        { value: 'ICL_uranus_zh_male_siwenqingnian_tob', label: '斯文青年' },
        { value: 'ICL_uranus_zh_male_tianxinanyou_tob', label: '甜系男友' },
        { value: 'ICL_uranus_zh_male_tiexinnanyou_tob', label: '贴心男友' },
        { value: 'ICL_uranus_zh_male_wenrounantongzhuo_tob', label: '温柔男同桌' },
        { value: 'ICL_uranus_zh_male_wenrounanyou_tob', label: '温柔男友' },
        { value: 'ICL_uranus_zh_male_wenrouxuezhang_tob', label: '温柔学长' },
        { value: 'ICL_uranus_zh_male_wenrunxuezhe_tob', label: '温润学者' },
        { value: 'ICL_uranus_zh_male_wenshunshaonian_tob', label: '温顺少年' },
        { value: 'ICL_uranus_zh_male_guayanxiaoge_tob', label: '寡言小哥' },
        { value: 'ICL_uranus_zh_male_xiaohouye_tob', label: '小侯爷' },
        { value: 'ICL_uranus_zh_male_naiqixiaosheng_tob', label: '奶气小生' },
        { value: 'ICL_uranus_zh_male_xiaosasuixing_tob', label: '潇洒随性' },
        { value: 'ICL_uranus_zh_male_wenrouneilian_tob', label: '温柔内敛' },
        { value: 'ICL_uranus_zh_male_xuebanantongzhuo_tob', label: '学霸男同桌' },
        { value: 'ICL_uranus_zh_male_xuebatongzhuo_tob', label: '学霸同桌' },
        { value: 'ICL_uranus_zh_male_yiqishaonian_tob', label: '意气少年' },
        { value: 'ICL_uranus_zh_male_younidashu_tob', label: '油腻大叔' },
        { value: 'ICL_uranus_zh_male_youmodaye_tob', label: '幽默大爷' },
        { value: 'ICL_uranus_zh_male_youmoshushu_tob', label: '幽默叔叔' },
        { value: 'ICL_uranus_zh_male_youroubangzhu_tob', label: '优柔帮主' },
        { value: 'ICL_uranus_zh_male_yourougongzi_tob', label: '优柔公子' },
        { value: 'ICL_uranus_zh_male_yuanqishaonian_tob', label: '元气少年' },
        { value: 'ICL_uranus_zh_male_zhangjianjunzi_tob', label: '仗剑君子' },
        { value: 'ICL_uranus_zh_male_zhangjianxiake_tob', label: '仗剑侠客' },
        { value: 'ICL_uranus_zh_male_zhengzhiqingnian_tob', label: '正直青年' },
        { value: 'ICL_uranus_zh_male_zhishuaiqingnian_tob', label: '直率青年' },
        { value: 'ICL_uranus_zh_male_zhongerqingnian_tob', label: '中二青年' },
        { value: 'ICL_uranus_zh_male_zifuqingnian_tob', label: '自负青年' },
        { value: 'ICL_uranus_zh_male_zixinqingnian_tob', label: '自信青年' },
        { value: 'ICL_uranus_zh_male_tiancaitongzhuo_tob', label: '天才同桌' },
        { value: 'ICL_uranus_zh_male_shuanglangshaonian_tob', label: '爽朗少年' },
      ],
    },
  ],
  en: [
    {
      group: '2.0 · 通用',
      options: [
        { value: 'en_male_tim_uranus_bigtts', label: 'Tim · 男声' },
        { value: 'en_female_dacey_uranus_bigtts', label: 'Dacey · 女声' },
        { value: 'en_female_stokie_uranus_bigtts', label: 'Stokie · 女声' },
      ],
    },
    {
      group: '角色扮演 · 英语',
      options: [
        { value: 'ICL_uranus_en_female_charlie_tob', label: 'Charlie' },
        { value: 'ICL_uranus_en_male_ethan_tob', label: 'Ethan' },
        { value: 'ICL_uranus_en_male_alastor_tob', label: 'Alastor' },
        { value: 'ICL_uranus_en_male_chucky_tob', label: 'Chucky' },
        { value: 'ICL_uranus_en_male_noah_tob', label: 'Noah' },
        { value: 'ICL_uranus_en_male_jigsaw_tob', label: 'Jigsaw' },
        { value: 'ICL_uranus_en_male_clown_man_tob', label: 'Clown Man' },
        { value: 'ICL_uranus_en_male_cartoon_chef_tob', label: 'Cartoon Chef' },
        { value: 'ICL_uranus_en_male_frosty_man_tob', label: 'Frosty Man' },
        { value: 'ICL_uranus_en_male_the_grinch_tob', label: 'The Grinch' },
        { value: 'ICL_uranus_en_male_kevin_mccallister_tob', label: 'Kevin McCallister' },
        { value: 'ICL_uranus_en_male_michael_tob', label: 'Michael' },
        { value: 'ICL_uranus_en_male_big_boogie_tob', label: 'Big Boogie' },
        { value: 'ICL_uranus_en_male_xavier_tob', label: 'Xavier' },
        { value: 'ICL_uranus_en_male_zayne_tob', label: 'Zayne' },
      ],
    },
  ],
  es: [],
};

/** 火山下拉的逃生项:选它 = 该语言不走火山,回退 edge-tts(垫片读空串)。 */
export const VOLCANO_FALLBACK_VALUE = '';

/** 试听样句(按语言)。 */
export const TTS_AUDITION_SAMPLES: Record<TtsLang, string> = {
  zh: '老板，任务已经完成，这是今天的进度汇报。',
  en: "Boss, the task is complete. Here is today's status report.",
  es: 'Jefe, la tarea está completa. Aquí está el informe de hoy.',
};

export const TTS_LANG_LABELS: Record<TtsLang, string> = {
  zh: '中文',
  en: '英文',
  es: '西班牙语',
};

const LOCAL_REL_PATH = 'tools/edge-tts/voices.local.json';
const DEFAULTS_REL_PATH = 'tools/edge-tts/voices.json';
const TOOL_DIR_REL_PATH = 'tools/edge-tts';

async function resolvePath(relativePath: string): Promise<{ exists: boolean; path: string }> {
  const res = await authFetch(apiUrl(`/api/files/exists?path=${encodeURIComponent(relativePath)}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.path !== 'string') {
    throw new Error(data.error || `路径解析失败(${res.status})`);
  }
  return { exists: !!data.exists, path: data.path };
}

async function readJson(absPath: string): Promise<unknown> {
  const res = await authFetch(apiUrl(`/api/files/read?path=${encodeURIComponent(absPath)}`));
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  try {
    return JSON.parse(String(data.content ?? ''));
  } catch {
    return null;
  }
}

/** 数值字段(rate/volume):接受数字或数字串,钳到 [-100,100];非法/缺失走默认。 */
export function sanitizeTuning(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/%$/, ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-100, Math.min(100, n));
}

/**
 * 白名单重建:只认已知字段,其余保持默认(新增字段必须在此登记,否则会被静默丢掉)。
 * 注意 volcano 要**深拷贝**——`{...fallback}` 是浅拷贝,直接改 cfg.volcano 会污染
 * 模块级 DEFAULT_TTS_VOICES(别名)。
 */
export function sanitize(raw: unknown, fallback: TtsVoiceConfig): TtsVoiceConfig {
  const cfg: TtsVoiceConfig = { ...fallback, volcano: { ...fallback.volcano } };
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const lang of ['zh', 'en', 'es'] as const) {
      const v = obj[lang];
      if (typeof v === 'string' && v.trim()) cfg[lang] = v.trim();
    }
    if (obj.engine === 'edge-tts' || obj.engine === 'volcano') cfg.engine = obj.engine;
    const volc = obj.volcano;
    if (volc && typeof volc === 'object') {
      const v = volc as Record<string, unknown>;
      for (const lang of ['zh', 'en', 'es'] as const) {
        if (typeof v[lang] === 'string') cfg.volcano[lang] = v[lang].trim(); // 空串保留(有效值)
      }
    }
    if (typeof obj.volcanoApiKey === 'string') cfg.volcanoApiKey = obj.volcanoApiKey.trim();
    if (typeof obj.volcanoResourceId === 'string') cfg.volcanoResourceId = obj.volcanoResourceId.trim();
    cfg.rate = sanitizeTuning(obj.rate, fallback.rate);
    cfg.volume = sanitizeTuning(obj.volume, fallback.volume);
  }
  return cfg;
}

// ---------------------------------------------------------------- 上次播报状态

const STATE_REL_PATH = 'tools/edge-tts/shim-state.json';

/** 垫片每次合成后原子写的状态(见 tools/edge-tts/shim/tts_shim.py write_state)。 */
export interface TtsShimState {
  time?: string;
  /** 配置里选的引擎。 */
  engine?: string;
  /** 实际出声的合成器。 */
  used?: 'volcano' | 'edge-tts' | 'piper';
  ok?: boolean;
  voice?: string;
  /** 非空 = 发生了回退(如 volcano->edge-tts / piper_real)。 */
  fallback?: string | null;
  /** 回退/跳过原因(已截断,不含凭据)。 */
  reason?: string | null;
  /** 火山计费字符数(如「17字」)。 */
  usage?: string | null;
  ms?: number;
}

export interface TtsShimStateView {
  level: 'ok' | 'warn' | 'info';
  key: string;
  params: Record<string, string>;
}

/**
 * 状态 → 展示语义(纯函数,可单测)。五态:
 *   volcano 成功 / 火山失败回退 edge / 连 edge 也失败回退 piper / 普通 edge(含按配置回退) / 无记录
 */
export function describeShimState(state: TtsShimState | null | undefined): TtsShimStateView {
  if (!state || !state.used) return { level: 'info', key: 'lastNone', params: {} };
  if (state.used === 'volcano') {
    return { level: 'ok', key: 'lastOkVolcano', params: { voice: state.voice ?? '', usage: state.usage ?? '' } };
  }
  if (state.used === 'piper') {
    return { level: 'warn', key: 'lastFallbackPiper', params: { reason: state.reason ?? '' } };
  }
  if (state.fallback) { // used === 'edge-tts' 且发生了火山→edge 回退
    return { level: 'warn', key: 'lastFallbackEdge', params: { reason: state.reason ?? '' } };
  }
  return { level: 'info', key: 'lastOkEdge', params: { voice: state.voice ?? '' } };
}

/** 读 shim-state.json(垫片写的「上次播报实际引擎」);缺失/损坏回 null,不抛出。 */
export async function loadTtsShimState(): Promise<TtsShimState | null> {
  try {
    const file = await resolvePath(STATE_REL_PATH);
    if (!file.exists) return null;
    const raw = await readJson(file.path);
    return raw && typeof raw === 'object' ? (raw as TtsShimState) : null;
  } catch {
    return null;
  }
}

/**
 * 读取生效音色:voices.local.json(用户覆盖,exists=true)优先,
 * 否则读入库默认 voices.json 仅用于回显;任何失败回默认值,不抛出。
 */
export async function loadTtsVoices(): Promise<{ config: TtsVoiceConfig; exists: boolean }> {
  const local = await resolvePath(LOCAL_REL_PATH);
  if (local.exists) {
    const raw = await readJson(local.path);
    return { config: sanitize(raw, DEFAULT_TTS_VOICES), exists: true };
  }
  const base = await resolvePath(DEFAULTS_REL_PATH);
  if (base.exists) {
    const raw = await readJson(base.path);
    return { config: sanitize(raw, DEFAULT_TTS_VOICES), exists: false };
  }
  return { config: { ...DEFAULT_TTS_VOICES }, exists: false };
}

/** 写入 voices.local.json(不存在则先创建);返回写入的绝对路径。 */
export async function saveTtsVoices(config: TtsVoiceConfig): Promise<string> {
  const file = await resolvePath(LOCAL_REL_PATH);
  if (!file.exists) {
    const dir = await resolvePath(TOOL_DIR_REL_PATH);
    if (!dir.exists) {
      throw new Error('找不到 tools/edge-tts 目录(服务端需从仓库根目录启动)');
    }
    const createRes = await authFetch(apiUrl('/api/files/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentDir: dir.path, name: 'voices.local.json' }),
    });
    // 409 = 已存在(并发创建),视为成功
    if (!createRes.ok && createRes.status !== 409) {
      const err = await createRes.json().catch(() => ({}));
      throw new Error(err.error || `创建 voices.local.json 失败(${createRes.status})`);
    }
  }
  const writeRes = await authFetch(apiUrl('/api/files/write'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: file.path, content: JSON.stringify(config, null, 2) + '\n' }),
  });
  if (!writeRes.ok) {
    const err = await writeRes.json().catch(() => ({}));
    throw new Error(err.error || `写入 voices.local.json 失败(${writeRes.status})`);
  }
  return file.path;
}
