/**
 * GICS sector per universe ric (trader upstream issue 28), published as
 * `instruments.sector` and denormalised by the OMS onto `positions`.
 * Hand-assigned from public GICS classifications; stale tickers (e.g. BG.L,
 * SAB.L) use their sector when they were listed.
 */
export const Sector = {
  Energy: "Energy",
  Materials: "Materials",
  Industrials: "Industrials",
  ConsumerDiscretionary: "Consumer Discretionary",
  ConsumerStaples: "Consumer Staples",
  HealthCare: "Health Care",
  Financials: "Financials",
  InformationTechnology: "Information Technology",
  CommunicationServices: "Communication Services",
  Utilities: "Utilities",
  RealEstate: "Real Estate",
} as const;
export type Sector = (typeof Sector)[keyof typeof Sector];

// biome-ignore format: data table
const RICS_BY_SECTOR: Record<Sector, readonly string[]> = {
  [Sector.Energy]: [
    "BG.L", "BP.L", "RDSA.L", "RDSB.L", "BKR.OQ", "FANG.OQ", "XOM.N", "CVX.N", "0386.HK", "0857.HK",
    "0883.HK", "1088.HK", "TTEF.PA", "ENI.MI",
  ],
  [Sector.Materials]: [
    "AAL.L", "ANTO.L", "BLT.L", "CRH.L", "FRES.L", "GLEN.L", "JMAT.L", "MNDI.L", "RIO.L", "RRS.L", "LIN.N",
    "1378.HK", "2899.HK", "BASFn.DE",
  ],
  [Sector.Industrials]: [
    "AHT.L", "BA.L", "BAB.L", "BNZL.L", "CPI.L", "EXPN.L", "EZJ.L", "GFS.L", "IAG.L", "ITRK.L", "MGGT.L",
    "REL.L", "RMG.L", "RR.L", "SMIN.L", "TPK.L", "WOS.L", "HON.OQ", "ADP.OQ", "CSX.OQ", "CTAS.OQ", "PCAR.OQ",
    "ODFL.OQ", "CPRT.OQ", "PAYX.OQ", "VRSK.OQ", "FAST.OQ", "0001.HK", "0066.HK", "0267.HK", "0316.HK",
    "0669.HK", "0868.HK", "SIEGn.DE", "AIR.PA", "ABBN.S",
  ],
  [Sector.ConsumerDiscretionary]: [
    "BDEV.L", "BKG.L", "BRBY.L", "CCL.L", "CPG.L", "DC.L", "GKN.L", "IHG.L", "KGF.L", "NXT.L", "PSON.L",
    "SPD.L", "TUI.L", "TW.L", "WTB.L", "AMZN.OQ", "TSLA.OQ", "BKNG.OQ", "SBUX.OQ", "MELI.OQ", "PDD.OQ",
    "MAR.OQ", "ABNB.OQ", "ORLY.OQ", "LULU.OQ", "ROST.OQ", "EBAY.OQ", "JD.OQ", "LCID.OQ", "HD.N", "MCD.N",
    "0027.HK", "0175.HK", "0881.HK", "1211.HK", "1928.HK", "1929.HK", "2020.HK", "2313.HK", "2331.HK",
    "3690.HK", "6690.HK", "6862.HK", "9618.HK", "9961.HK", "9988.HK", "MBGn.DE", "BMWG.DE", "ADSGn.DE",
    "LVMH.PA", "RACE.MI",
  ],
  [Sector.ConsumerStaples]: [
    "ABF.L", "BATS.L", "DGE.L", "IMT.L", "MKS.L", "MRW.L", "RB.L", "SAB.L", "SBRY.L", "TSCO.L", "ULVR.L",
    "COST.OQ", "PEP.OQ", "MDLZ.OQ", "MNST.OQ", "0.404.OQ", "KHC.OQ", "DLTR.OQ", "WBA.OQ", "PG.N", "WMT.N",
    "KO.N", "0241.HK", "0288.HK", "0291.HK", "0322.HK", "1044.HK", "1876.HK", "2319.HK", "6618.HK", "9633.HK",
    "HEIN.AS", "AD.AS", "OREP.PA", "NESN.S",
  ],
  [Sector.HealthCare]: [
    "AZN.L", "GSK.L", "HIK.L", "SHP.L", "SN.L", "AMGN.OQ", "ISRG.OQ", "GILD.OQ", "VRTX.OQ", "REGN.OQ",
    "AZN.OQ", "SGEN.OQ", "MRNA.OQ", "BIIB.OQ", "IDXX.OQ", "DXCM.OQ", "GEHC.OQ", "ALGN.OQ", "ILMN.OQ", "UNH.N",
    "LLY.N", "JNJ.N", "BBV.N", "MRK.N", "TMO.N", "PFE.N", "ABT.N", "1093.HK", "1099.HK", "1177.HK", "2269.HK",
    "3692.HK", "BAYGn.DE", "PHG.AS", "SASY.PA", "NOVN.S", "ROG.S",
  ],
  [Sector.Financials]: [
    "ADM.L", "ADN.L", "AV.L", "BARC.L", "DLG.L", "HL.L", "HSBA.L", "III.L", "LGEN.L", "LLOY.L", "LSE.L",
    "OML.L", "PRU.L", "RBS.L", "RSA.L", "SDR.L", "SL.L", "STAN.L", "STJ.L", "PYPL.OQ", "BRKb.N", "JPM.N",
    "V.N", "MA.N", "BAC.N", "0005.HK", "0011.HK", "0388.HK", "0939.HK", "1299.HK", "1398.HK", "2318.HK",
    "2388.HK", "2628.HK", "3968.HK", "3988.HK", "ALVG.DE", "MUVGn.DE", "DBKGn.DE", "INGA.AS", "ADYEN.AS",
    "BNPP.PA", "ISP.MI", "CRDI.MI", "UBSG.S",
  ],
  [Sector.InformationTechnology]: [
    "ARM.L", "SGE.L", "AAPL.OQ", "MSFT.OQ", "NVDA.OQ", "AVGO.OQ", "ADBE.OQ", "CSCO.OQ", "AMD.OQ", "TXN.OQ",
    "INTC.OQ", "INTU.OQ", "QCOM.OQ", "AMAT.OQ", "ADI.OQ", "LRCX.OQ", "MU.OQ", "PANW.OQ", "SNPS.OQ", "CDNS.OQ",
    "KLAC.OQ", "ASML.OQ", "NXPI.OQ", "WDAY.OQ", "FTNT.OQ", "MRVL.OQ", "ADSK.OQ", "MCHP.OQ", "ON.OQ",
    "CRWD.OQ", "CTSH.OQ", "GFS.OQ", "TEAM.OQ", "DDOG.OQ", "ANSS.OQ", "ZS.OQ", "ZM.OQ", "ENPH.OQ", "ACN.N",
    "CRM.N", "ORCL.N", "0968.HK", "0981.HK", "0992.HK", "1810.HK", "2382.HK", "SAPG.DE", "IFXGn.DE",
    "ASML.AS",
  ],
  [Sector.CommunicationServices]: [
    "ISAT.L", "ITV.L", "SKY.L", "VOD.L", "WPP.L", "META.OQ", "GOOGL.OQ", "GOOG.OQ", "CMCSA.OQ", "NFLX.OQ",
    "TMUS.OQ", "CHTR.OQ", "TTD.OQ", "EA.OQ", "WBD.OQ", "SIRI.OQ", "0700.HK", "0762.HK", "0941.HK", "9888.HK",
    "9999.HK", "DTEGn.DE",
  ],
  [Sector.Utilities]: [
    "CNA.L", "NG.L", "SSE.L", "SVT.L", "UU.L", "AEP.OQ", "EXC.OQ", "CEG.OQ", "XEL.OQ", "0002.HK", "0003.HK",
    "0006.HK", "0836.HK", "1038.HK", "2688.HK", "ENEI.MI",
  ],
  [Sector.RealEstate]: [
    "BLND.L", "HMSO.L", "INTU.L", "LAND.L", "CSGP.OQ", "0012.HK", "0016.HK", "0017.HK", "0101.HK", "0688.HK",
    "0823.HK", "0960.HK", "1109.HK", "1113.HK", "1209.HK", "1997.HK", "6098.HK",
  ],
};

/** ric -> sector for the whole universe. */
export const SECTOR_BY_RIC: ReadonlyMap<string, Sector> = new Map(
  Object.entries(RICS_BY_SECTOR).flatMap(([sector, rics]) =>
    rics.map((ric) => [ric, sector as Sector] as const),
  ),
);
