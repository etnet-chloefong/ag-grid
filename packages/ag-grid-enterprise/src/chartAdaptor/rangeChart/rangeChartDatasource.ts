import {
    _,
    Autowired,
    BeanStub,
    CellRange,
    Column,
    ColumnController,
    IAggFunc,
    IRowModel,
    PostConstruct,
    ValueService
} from "ag-grid-community";
import { RangeController } from "../../rangeController";
import { AggregationStage } from "../../rowStages/aggregationStage";
import { ChartData, ChartDatasource } from "./rangeChartService";

export class RangeChartDatasource extends BeanStub implements ChartDatasource {

    @Autowired('columnController') columnController: ColumnController;
    @Autowired('valueService') valueService: ValueService;
    @Autowired('rowModel') gridRowModel: IRowModel;
    @Autowired('rangeController') rangeController: RangeController;
    @Autowired('aggregationStage') aggregationStage: AggregationStage;

    private readonly cellRange: CellRange;
    private readonly aggFunc: IAggFunc | string | undefined;

    private startRow: number;
    private endRow: number;

    private colIds: string[];
    private colDisplayNames: string[];
    private colsMapped: {[colId: string]: Column};
    private fieldCols: Column[];
    private categoryCols: Column[];
    private dataFromGrid: any[];
    private dataGrouped: any[];

    private errors: string[] = [];

    constructor(cellRange: CellRange, aggFunc?: IAggFunc | string) {
        super();
        this.cellRange = cellRange;
        this.aggFunc = aggFunc;
    }

    public getChartData(): ChartData {
        this.clearErrors();

        this.calculateFields();
        this.calculateCategoryCols();
        this.extractRowsFromGridRowModel();
        this.groupRowsByCategory();

        return {
            cellRange: this.cellRange,
            colIds: this.colIds,
            colDisplayNames: this.colDisplayNames,
            dataGrouped: this.dataGrouped,
            colsMapped: this.colsMapped,
            categoryCols: this.categoryCols
        };
    }

    public getErrors(): string[] {
        return this.errors;
    }

    private clearErrors(): void {
        this.errors = [];
    }

    private addError(error: string): void {
        this.errors.push(error);
    }

    private groupRowsByCategory(): void {
        this.dataGrouped = this.dataFromGrid;

        const doingGrouping = this.categoryCols.length > 0 && _.exists(this.aggFunc);

        if (!doingGrouping) {
            this.dataGrouped = this.dataFromGrid;
            return;
        }

        this.dataGrouped = [];

        const map: any = {};
        const lastCol = this.categoryCols[this.categoryCols.length - 1];

        this.dataFromGrid.forEach(data => {
            let currentMap = map;
            this.categoryCols.forEach(col => {
                const key = data[col.getId()];
                if (col === lastCol) {
                    let groupItem = currentMap[key];
                    if (!groupItem) {
                        groupItem = {__children: []};
                        this.categoryCols.forEach(col => {
                                groupItem[col.getId()] = data[col.getId()];
                        });
                        currentMap[key] = groupItem;
                        this.dataGrouped.push(groupItem);
                    }
                    groupItem.__children.push(data);
                } else {
                    // map of maps
                    if (!currentMap[key]) {
                        currentMap[key] = {};
                    }
                    currentMap = currentMap[key];
                }
            });
        });

        this.dataGrouped.forEach(groupItem => {
            this.fieldCols.forEach(col => {
                const dataToAgg: any[] = [];
                groupItem.__children.forEach((child:any) => {
                    dataToAgg.push(child[col.getId()]);
                });
                // always use 'sum' agg func, is that right????
                const aggResult = this.aggregationStage.aggregateValues(dataToAgg, 'sum');
                groupItem[col.getId()] = aggResult;
            });
        });
    }

    private calculateCategoryCols(): void {
        this.categoryCols = [];
        if (!this.cellRange.columns) { return; }

        const displayedCols = this.columnController.getAllDisplayedColumns();

        const isDimension = (col:Column) =>
            // col has to be defined by user as a dimension
            (col.getColDef().enableRowGroup || col.getColDef().enablePivot)
            &&
            // plus the col must be visible
            displayedCols.indexOf(col) >= 0;

        // pull out all dimension columns from the range
        this.cellRange.columns.forEach(col => {
            if (isDimension(col)) {
                this.categoryCols.push(col);
            }
        });

        // if no dimension columns in the range, then pull out first dimension column from displayed columns
        if (this.categoryCols.length === 0) {
            displayedCols!.forEach(col => {
                if (this.categoryCols.length === 0 && isDimension(col)) {
                    this.categoryCols.push(col);
                }
            });
        }
    }

    private extractRowsFromGridRowModel(): void {

        this.startRow = this.rangeController.getRangeStartRow(this.cellRange).rowIndex;
        this.endRow = this.rangeController.getRangeEndRow(this.cellRange).rowIndex;

        // make sure enough rows in range to chart. if user filters and less rows, then
        // end row will be the last displayed row, not where the range ends.
        const modelLastRow = this.gridRowModel.getRowCount() - 1;
        const rangeLastRow = Math.min(this.endRow, modelLastRow);

        const rowCount = rangeLastRow - this.startRow + 1;

        this.dataFromGrid = [];
        for (let i = 0; i < rowCount; i++) {
            const rowNode = this.gridRowModel.getRow(i + this.startRow)!;
            const data: any = {};

            this.categoryCols.forEach(col => {
                const part = this.valueService.getValue(col, rowNode);
                // force return type to be string or empty string (as value can be an object)
                const partStr = (part && part.toString) ? part.toString() : '';
                data[col.getId()] = partStr;
            });

            this.fieldCols.forEach(col => {
                data[col.getId()] = this.valueService.getValue(col, rowNode);
            });

            this.dataFromGrid.push(data);
        }

        if (rowCount <= 0) {
            this.addError('No rows in selected range.');
        }
    }

    private calculateFields(): void {

        this.colIds = [];
        this.colDisplayNames = [];
        this.colsMapped = {};
        this.fieldCols = [];

        const colsInRange = this.cellRange.columns || [];

        const displayedCols = this.columnController.getAllDisplayedColumns();

        this.fieldCols = colsInRange.filter(col =>
            // all columns must have enableValue enabled
            col.getColDef().enableValue
            // and the column must be visible in the grid. this gets around issues where user switches
            // into / our of pivot mode (range no longer valid as switching between primary and secondary cols)
            && displayedCols.indexOf(col) >= 0
        );

        if (this.fieldCols.length === 0) {
            this.addError('No value column in selected range.');
        }

        this.fieldCols.forEach(col => {

            const colId = col.getColId();
            const displayName = this.columnController.getDisplayNameForColumn(col, 'chart');

            this.colIds.push(colId);
            this.colDisplayNames.push(displayName ? displayName : '');

            this.colsMapped[colId] = col;
        });
    }
}